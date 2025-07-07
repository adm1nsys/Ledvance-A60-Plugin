#!/usr/bin/env python3
"""
LedvanceE27A60.py — CLI utility for Ledvance Smart+ E27 A60 RGBW lamp
(Tuya protocol 3.5).

Tested on:
Ledvance Smart+ WiFi E27 A60
Main Module: V1.5.32
MCU Module: V1.5.32
RN bundle version: V1.3.0

USAGE (first 3 arguments are mandatory):
    LedvanceE27A60.py DEV_ID IP LOCAL_KEY [options]
    Example: python LedvanceE27A60.py a1b2c3d4e5f6g7h8ijklmn 192.168.0.238 'WQ!zYx8#kLp3vBn@' --tail

Options (can be combined):
  --status                       print DPS once and exit
  --tail [SEC]                   continuously print DPS every SEC (default 1)
  --on / --off                   turn on / off (DPS 20)
  --brightness    1-100          brightness %  (DPS 22, white mode)
  --shade         2700-6500      color temperature K (≈2700–6500 → DPS 23)
  --rgb           R,G,B          set RGB color (0-255,0-255,0-255)
  --saturation    1-100          saturation for --rgb (default 100)
  --raw           HHHHSSSSVVVV   12-hex string for DPS 24 (alternative to RGB)
  --debug                        verbose tinytuya log
  --version                      print utility version
"""
import argparse, colorsys, sys, time, datetime as dt
import tinytuya

VERSION = "0.1"

# ---------------- helpers -----------------

def kelvin_to_dps23(k: int) -> int:
    k = max(2300, min(9000, k))
    return int(round((k - 2300) / (9000 - 2300) * 800 + 100))

def hsv_hex(h_deg: float, s: float = 1.0, v: float = 1.0) -> str:
    return f"{int(h_deg % 360):04x}{int(s * 1000):04x}{int(v * 1000):04x}"

def timestamp() -> str:
    return dt.datetime.now().strftime("%H:%M:%S")

# -------------- argparser -----------------

def get_parser() -> argparse.ArgumentParser:
    description = (
        "CLI utility for Ledvance Smart+ E27 A60 RGBW lamp (Tuya protocol 3.5).\n"
        "Tested on:\n"
        "  Ledvance Smart+ WiFi E27 A60\n"
        "  Main Module: V1.5.32\n"
        "  MCU Module: V1.5.32\n"
        "  RN bundle version: V1.3.0\n\n"
        "USAGE (first 3 arguments are mandatory):\n"
        "  LedvanceE27A60.py DEV_ID IP LOCAL_KEY [options]\n"
        "  Example: python LedvanceE27A60.py a1b2c3d4e5f6g7h8ijklmn 192.168.0.238 'WQ!zYx8#kLp3vBn@' --tail\n\n"
        f"Version: {VERSION}"
    )

    p = argparse.ArgumentParser(
        description=description,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    p.add_argument("dev_id", help="Device ID")
    p.add_argument("ip", help="Local IP Address")
    p.add_argument("local_key", help="Local Key")

    pow_grp = p.add_mutually_exclusive_group()
    pow_grp.add_argument("--on", action="store_true", help="Turn on the bulb (DPS 20)")
    pow_grp.add_argument("--off", action="store_true", help="Turn off the bulb (DPS 20)")

    p.add_argument("--status", action="store_true", help="Print current device status")
    p.add_argument("--tail", nargs="?", const="1", metavar="SEC", help="Continuously print status every SEC (default: 1)")
    p.add_argument("--brightness", type=int, metavar="1-100", help="print utility version")
    p.add_argument("--shade", type=int, metavar="2700K-6500K", help="Color temperature in Kelvin (DPS 23)")
    p.add_argument("--rgb", metavar="R,G,B", help="RGB color (0-255 each)")
    p.add_argument("--saturation", type=int, default=100, metavar="1-100", help="Saturation for RGB (default: 100)")
    p.add_argument("--raw", metavar="HHHHSSSSVVVV", help="12-digit hex HSV string (DPS 24)")
    p.add_argument("--debug", action="store_true", help="Enable verbose tinytuya logs (and fast test)")
    p.add_argument("--version", action="version", version=VERSION, help="print utility version")
    return p

# --------------- main ---------------------

def main():
    args = get_parser().parse_args()

    if args.debug:
        tinytuya.set_debug()

    bulb = tinytuya.BulbDevice(args.dev_id, args.ip, args.local_key)
    bulb.set_version(3.5)
    bulb.set_socketPersistent(True)

    # ---- tail mode --------------------------------------------------------
    if args.tail is not None:
        interval = max(0.2, float(args.tail))
        try:
            while True:
                print(timestamp(), bulb.status().get("dps", {}))
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nStopped.")
        sys.exit()

    # ---- single status ----------------------------------------------------
    if args.status and not any([args.on, args.off, args.brightness, args.shade, args.rgb, args.raw]):
        print(bulb.status())
        sys.exit()

    # ---- power ------------------------------------------------------------
    if args.on:
        bulb.set_value("20", True)
    if args.off:
        bulb.set_value("20", False)

    # ---- white adjustments ------------------------------------------------
    if args.brightness is not None or args.shade is not None:
        payload = {"21": "white"}
        if args.brightness is not None:
            payload["22"] = max(1, min(100, args.brightness)) * 10
        if args.shade is not None:
            payload["23"] = kelvin_to_dps23(args.shade)
        bulb.set_multiple_values(payload)

    # ---- colour -----------------------------------------------------------
    if args.rgb or args.raw:
        bulb.set_multiple_values({"21": "colour"})
        time.sleep(0.3)
        if args.raw:
            bulb.set_value("24", args.raw.lower())
        else:
            try:
                r, g, b = map(int, args.rgb.split(","))
            except ValueError:
                sys.exit("--rgb requires R,G,B with 0-255 numbers")
            sat = max(1, min(100, args.saturation)) / 100
            hue = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360
            bulb.set_value("24", hsv_hex(hue, sat, 1.0))

    # ---- final status -----------------------------------------------------
    time.sleep(0.3)
    print(bulb.status())


if __name__ == "__main__":
    main()
