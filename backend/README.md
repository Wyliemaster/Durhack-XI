# Sensor backend

Flask service that exposes the state of the HC-SR04 ultrasonic sensor and the
3-pin touch sensor.

The hardware code lives in `backend/sensors/`: `sonicsensor.py` and
`touchsensor.py` own the devices, and `sensor_controller.py` aggregates them
into one state dictionary.

The endpoint reads the sensors directly on every request; there is no
background sampler or cached sensor reading. Each sensor module owns its own
lock; the HC-SR04 trigger/echo pair cannot be used by two reads at once.

## API

```
GET http://<pi-ip>:5001/sensors_state
```

```json
{"sonic": false, "touch": false}
```

- `sonic` is `true` while something is within `SONIC_TRIGGER_CM` (default
  30 cm) and becomes `false` again at `SONIC_RELEASE_CM` (default 35 cm).
  No echo, timeout, or sensor error reports `false`.
- `touch` is `true` while the touch sensor is touched.
- Both values are levels, not events. The frontend should trigger game actions
  on the `false -> true` edge.
- Responses include `Cache-Control: no-store` and
  `Access-Control-Allow-Origin: *`.

The endpoint blocks for the duration of the ultrasonic measurement: about
3 ms at 30 cm and up to ~17 ms when no echo is received (with the default
1 m maximum distance). That is well within a 50 ms poll interval.

## Wiring

All GPIO numbers are BCM numbers, not physical header pin numbers.

### HC-SR04

| HC-SR04 | Pi 5 |
|---|---|
| VCC | 5V (physical pin 2 or 4) |
| GND | GND (pin 6) |
| TRIG | GPIO23 (pin 16) |
| ECHO | GPIO24 (pin 18) through a divider |

ECHO is a 5 V signal and the Pi GPIOs are 3.3 V. Do not connect it directly.

```
HC-SR04 ECHO ----[1k]----+---- GPIO24
                         |
                       [2k]
                         |
                        GND
```

That gives about 3.3 V at the GPIO. A 330R/470R divider (about 3 V, as
recommended by gpiozero) also works; the ratio is what matters.

TRIG is driven at 3.3 V. Most HC-SR04 modules accept that; if yours does not
trigger reliably, put a level shifter on TRIG as well. If you have the
3.3 V-tolerant HC-SR04P instead, ECHO can be connected directly.

### Touch sensor

| Touch module | Pi 5 |
|---|---|
| VCC | 3.3V (physical pin 1 or 17) |
| GND | GND |
| SIG | GPIO17 (pin 11) |

Power the module from 3.3 V so SIG cannot exceed the Pi's 3.3 V logic level.
If your module requires 5 V, put a divider or level shifter on SIG too.
Connect all grounds together.

The default assumes SIG is HIGH when touched. If your module is active-low,
set `TOUCH_ACTIVE_LOW=1`.

## Install and run (Raspberry Pi 5)

The Pi needs `gpiozero` and `lgpio`. Raspberry Pi OS provides them; a venv
must be created with `--system-site-packages` so it can see them.

```bash
cd /path/to/Durhack-XI
python3 -m venv --system-site-packages venv
. venv/bin/activate
pip install -r backend/requirements.txt
python backend/app.py
```

If you already have a venv without that flag, either recreate it or install
`gpiozero` and `lgpio` into it as well.

Check it locally:

```bash
curl http://localhost:5001/sensors_state
```

From another device, use the Pi's address (`hostname -I`):

```bash
curl http://<pi-ip>:5001/sensors_state
```

Run it with `python backend/app.py`, not `flask run`: `main()` is what
initialises the GPIO devices. Only one backend process can own the pins at a
time.

The frontend is a separate process on its usual port (5000). Start it in
another terminal as before; the browser will call this backend on port 5001.

## Sensor check scripts

To check each sensor without running the HTTP app, run these from the repo
root:

```bash
python backend/tests/check_sonic.py
python backend/tests/check_touch.py
```

Both use the same sensor modules as the API, initialise only the sensor they
check, log once per second, and release the GPIO pins on Ctrl+C. Stop the
backend first; only one process can own the pins at a time.

- `check_sonic.py` prints the distance in cm, or `no echo / out of range`.
- `check_touch.py` prints `touched` or `not touched`.

## Adding another sensor

1. Create `backend/sensors/newsensor.py` with `init()`, `cleanup()`, and
   `read()` returning a dict such as `{"newsensor": False}`.
2. Add the module to `_SENSORS` in `backend/sensors/sensor_controller.py`.
3. Add its pin/config constants and validation to `backend/config.py`.
4. Optional: add `backend/tests/check_newsensor.py` using the same path
   bootstrap as the existing check scripts.

The controller merges each sensor's dict, so `GET /sensors_state` picks up the
new key automatically.

## Configuration

All settings are environment variables read at startup.

| Variable | Default | Meaning |
|---|---|---|
| `SENSOR_HOST` | `0.0.0.0` | Bind address |
| `SENSOR_PORT` | `5001` | HTTP port |
| `SONIC_TRIG_PIN` | `23` | HC-SR04 TRIG, BCM |
| `SONIC_ECHO_PIN` | `24` | HC-SR04 ECHO, BCM |
| `TOUCH_PIN` | `17` | Touch SIG, BCM |
| `SONIC_TRIGGER_CM` | `30` | Sonic becomes true at/below this |
| `SONIC_RELEASE_CM` | `35` | Sonic becomes false at/above this |
| `SONIC_MAX_DISTANCE_M` | `1.0` | Maximum measured distance / timeout |
| `TOUCH_ACTIVE_LOW` | `0` | Set to `1` for an active-low module |
| `TOUCH_BOUNCE_S` | `0.02` | Touch debounce in seconds |
| `LOG_LEVEL` | `INFO` | Use `DEBUG` for per-request distance logs |

Example:

```bash
SONIC_TRIGGER_CM=20 SONIC_RELEASE_CM=25 LOG_LEVEL=DEBUG python backend/app.py
```

## Frontend polling

Poll with a recursive `setTimeout` so requests cannot pile up:

```js
const SENSOR_URL = "http://<pi-ip>:5001/sensors_state";
let previous = { sonic: false, touch: false };

async function pollSensors() {
    try {
        const response = await fetch(SENSOR_URL, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`sensor API returned ${response.status}`);
        }
        const state = await response.json();

        if (state.sonic && !previous.sonic) {
            // sonic just became true
        }
        if (state.touch && !previous.touch) {
            // touch just became true
        }

        previous = state;
    } catch (error) {
        // Keep the previous state and retry.
    } finally {
        setTimeout(pollSensors, 50);
    }
}

pollSensors();
```

The HC-SR04 datasheet recommends a 60 ms measurement cycle. 50 ms usually
works; if the distance readings are unstable, poll every 60 ms instead.

Because the API returns levels rather than events, a tap shorter than the poll
interval can be missed. Human touches are normally longer than 50 ms; if you
need to catch very quick taps, poll faster or add a short latch to the backend.

Use one game tab during the demo. Each tab polls independently; the sensor
modules will serialise the extra reads, but they all hit the same sensors.

## Implementation note

`gpiozero.DistanceSensor` is intentionally not used. It runs its own background
thread that samples every 60 ms and keeps a median queue; it also ignores
readings where no echo was received, which can leave a stale "close" value
after the hand moves away. `backend/sensors/sonicsensor.py` reads the HC-SR04
directly, so the reported state is fresh and releases cleanly.

## Troubleshooting

- **`Permission denied` on `/dev/gpiochip4`**: add your user to the `gpio`
  group and log out/in:
  `sudo usermod -aG gpio $USER`
- **`Could not initialise the HC-SR04` or
  `Could not initialise the touch sensor`**: check the wiring and pin numbers,
  and run `python3 -c "import lgpio; print('lgpio import ok')"`.
  `GPIOZERO_PIN_FACTORY` defaults to `lgpio` in the sensor modules.
- **Sonic always false**: check 5 V on the HC-SR04, the ECHO divider, and the
  TRIG/ECHO pin numbers. Run with `LOG_LEVEL=DEBUG` to see the measured
  distance. The HC-SR04 cannot measure closer than about 2 cm.
- **Sonic stays true**: something is reflecting within the release distance, or
  `SONIC_RELEASE_CM` is too high. Mount the sensor so it faces the player and
  away from nearby surfaces.
- **Touch inverted**: set `TOUCH_ACTIVE_LOW=1`.
- **Touch stuck or toggles**: some 3-pin modules have a toggle-mode jumper;
  set it to momentary. Power the module from 3.3 V and check common ground.
- **Cannot reach the API from another device**: the service binds `0.0.0.0`
  by default; use the Pi's IP, not `localhost`. If a firewall is enabled,
  allow port 5001.
