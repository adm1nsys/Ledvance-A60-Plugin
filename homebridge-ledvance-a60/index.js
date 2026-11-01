'use strict';
const { execFile, execSync } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('LedvanceA60', LedvanceA60Accessory);
};

class LedvanceA60Accessory {
  constructor(log, config) {
    this.log   = log;
    this.name  = config.name || 'Ledvance A60';
    this.mac   = (config.mac || '').toLowerCase();
    this.devId = config.virtualId;
    this.key   = config.localKey;
    this.ip    = config.ip || null;            // may be fixed in config

    // default cached state to avoid undefined warnings
    this.last = {
      power: false,
      brightness: 100,
      hue: 0,
      sat: 0,
      kelvin: 4000,
      mired: 250,
      mode: 'white'
    };

    // timings
    this.pollMS   = config.pollInterval || 4000; // status every N ms
    this.hueDebounce = 180;                     // ms to wait between H/S updates
    this.pendingHS = null;                      // {hue, sat}
    this.hueTimer  = null;

    // HomeKit service -----------------------
    this.service = new Service.Lightbulb(this.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.get('power'))
      .onSet(v => this.setPower(v));

    this.service.getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 1, maxValue: 100 })
      .onGet(() => this.get('brightness'))
      .onSet(v => this.setBrightness(v));

    this.service.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minMired: 153, maxMired: 370 })
      .onGet(() => this.get('mired'))
      .onSet(v => this.setColorTemp(v));

    this.service.getCharacteristic(Characteristic.Hue)
      .onGet(() => this.get('hue'))
      .onSet(v => this.queueHueSat({ hue: v }));

    this.service.getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.get('sat'))
      .onSet(v => this.queueHueSat({ sat: v }));

    // initial state & polling --------------
    this.refresh();
    this.poller = setInterval(() => this.refresh(), this.pollMS);
  }

  // -------- helpers -----------------------

  arpLookupSync() {
    if (this.ip) return this.ip;
    try {
      const out = execSync('arp -an').toString();
      for (const ln of out.split('\n')) {
        const m = ln.match(/\(([\d.]+)\) at ([0-9a-f:]+)/i);
        if (m && m[2].toLowerCase() === this.mac) {
          this.ip = m[1];
          this.log(`Found the bulb at ${this.ip}`);
          break;
        }
      }
    } catch (e) {
      this.log.error('ARP lookup error', e);
    }
    return this.ip;
  }

  async callPy(args = [], needResult = false) {
    const ip = this.arpLookupSync();
    if (!ip) throw new Error('Bulb IP not found: set "ip" in the config or check that the MAC is in the ARP table');
    const py = path.join(__dirname, 'LedvanceE27A60.py');
    try {
      const { stdout } = await execFileAsync('python3', [py, this.devId, ip, this.key, ...args]);
      if (!needResult) return null;
      const lastLine = stdout.trim().split('\n').pop();
      const jsonLine = lastLine
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/None/g, 'null');
      return JSON.parse(jsonLine);
    } catch (err) {
      this.log.error(err);
      throw err;
    }
  }

  /** Convert Kelvin ↔︎ Mired */
  kelvin2Mired(k) { return Math.round(1e6 / k); }
  mired2Kelvin(m) { return Math.round(1e6 / m); }

  // HSV helper for Tuya DPS 24 ------------------
  hex4(n) { return Math.round(n).toString(16).padStart(4, '0'); }
  hsvHex(h, sP, vP) { return this.hex4(h % 360) + this.hex4(sP * 10) + this.hex4(vP * 10); }

  // -------- polling (status) -------------------
  async refresh() {
    try {
      const data = await this.callPy(['--status'], true);
      const dps  = data.dps || {};
      const mode = dps['21'] || 'white';

      if (mode === 'white') {
        const kelvin = 2300 + ((dps['23'] || 100) - 100) * (9000 - 2300) / 800;
        this.last = {
          mode,
          power: !!dps['20'],
          brightness: (dps['22'] || 1000) / 10,
          hue: this.last.hue,
          sat: this.last.sat,
          kelvin,
          mired: this.kelvin2Mired(kelvin)
        };
      } else {
        const raw = (dps['24'] || '000000000000').padStart(12, '0');
        this.last = {
          mode,
          power: !!dps['20'],
          hue:    parseInt(raw.slice(0, 4), 16),
          sat:    parseInt(raw.slice(4, 8), 16) / 10,
          brightness: parseInt(raw.slice(8, 12), 16) / 10,
          kelvin: this.last.kelvin,
          mired:  this.last.mired
        };
      }

      // push to HomeKit
      this.service.updateCharacteristic(Characteristic.On, this.last.power);
      this.service.updateCharacteristic(Characteristic.Brightness, this.last.brightness);
      if (this.last.mode === 'white') {
        this.service.updateCharacteristic(Characteristic.ColorTemperature, this.last.mired);
      } else {
        this.service.updateCharacteristic(Characteristic.Hue, this.last.hue);
        this.service.updateCharacteristic(Characteristic.Saturation, this.last.sat);
      }
    } catch (e) {
      // already logged inside callPy
    }
  }

  // cached getter --------------------------------
  get(key) {
    if (!this.last) {
      // should not happen thanks to default, but keep safe
      const defaults = { power:false, brightness:100, hue:0, sat:0, mired:250 };
      return defaults[key];
    }
    return this.last[key];
  }

  // ---------- setters ---------------------------
  async setPower(v) {
    try {
      await this.callPy([v ? '--on' : '--off']);
      this.last.power = v;
    } catch {}
  }

  async setBrightness(v) {
    try {
      if (this.last.mode === 'white') {
        await this.callPy(['--brightness', v]);
      } else {
        const raw = this.hsvHex(this.last.hue, this.last.sat, v);
        await this.callPy(['--raw', raw]);
      }
      this.last.brightness = v;
    } catch {}
  }

  async setColorTemp(mired) {
    try {
      const kelvin = this.mired2Kelvin(mired);
      await this.callPy(['--shade', kelvin]);
      this.last.kelvin = kelvin;
      this.last.mired  = mired;
      this.last.mode   = 'white';
    } catch {}
  }

  /* Combine Hue + Sat updates coming milliseconds apart */
  queueHueSat(part) {
    this.pendingHS = { ...(this.pendingHS || this.last), ...part };
    clearTimeout(this.hueTimer);
    this.hueTimer = setTimeout(() => this.flushHueSat(), this.hueDebounce);
  }

  async flushHueSat() {
    const { hue, sat, brightness } = { ...this.last, ...this.pendingHS };
    this.pendingHS = null;
    const raw = this.hsvHex(hue, sat, brightness);
    try {
      await this.callPy(['--raw', raw]);
      this.last.hue  = hue;
      this.last.sat  = sat;
      this.last.mode = 'colour';
    } catch {}
  }

  // ---------- mandatory -------------------------
  getServices() { return [this.service]; }
}
