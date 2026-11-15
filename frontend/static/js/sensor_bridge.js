/*
 * Sensor bridge for the DurHack game.
 *
 * Polls the Pi sensor API and turns raw readings into lane hits. This script
 * is loaded after main.js, which provides window.handle_lane_input(channel).
 *
 * Override the API URL with:
 *   ?sensor_api=http://PI_IP:5001/sensors_state
 */

// 20 Hz keeps the HC-SR04 happy; the game's hit window is much wider.
const SENSOR_POLL_MS = 50;
const SENSOR_RETRY_MS = 500;
const SENSOR_TIMEOUT_MS = 1000;

// Change these to move a sensor to a different instrument lane.
const SENSOR_LANES = {
    touch: 0,     // drums
    joystick: 1,  // bass
    gyro: 2,      // guitar
    sonic: 3      // piano
};

// Raw ADS7830 centre and the minimum distance before a direction counts.
const JOYSTICK_CENTER = 128;
const JOYSTICK_DEADZONE = 45;
const JOYSTICK_COOLDOWN_MS = 100;

// A deliberate twist is usually well above 150 deg/s. Re-arm once it settles.
const GYRO_TRIGGER_DPS = 150;
const GYRO_REARM_DPS = 50;
const GYRO_COOLDOWN_MS = 180;

const _sensor_params = new URLSearchParams(window.location.search);
const SENSOR_API_URL = _sensor_params.get("sensor_api") ||
    "http://" + (window.location.hostname || "localhost") + ":5001/sensors_state";

let _sensor_previous = null;
let _sensor_gyro_armed = true;
let _sensor_last_gyro_hit = 0;
let _sensor_last_joystick_hit = 0;
let _sensor_joystick_direction = null;
let _sensor_poll_timer = null;
let _sensor_stopped = false;
let _sensor_offline_logged = false;

window.SENSOR_STATUS = "connecting";
window.SENSOR_API_URL = SENSOR_API_URL;
window.SENSOR_LANES = SENSOR_LANES;

function sensor_trigger_lane(name) {
    const lane = SENSOR_LANES[name];

    if (lane === undefined || typeof window.handle_lane_input !== "function") {
        return;
    }

    window.handle_lane_input(lane);
}

function sensor_joystick_direction(joystick) {
    if (!joystick) {
        return null;
    }

    const x = Number(joystick.x);
    const y = Number(joystick.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }

    // The backend reports 0,0 when the ADC read fails; that is not a real
    // joystick position, so ignore it.
    if (x === 0 && y === 0) {
        return null;
    }

    const dx = x - JOYSTICK_CENTER;
    const dy = y - JOYSTICK_CENTER;

    if (Math.hypot(dx, dy) < JOYSTICK_DEADZONE) {
        return null;
    }

    if (Math.abs(dx) > Math.abs(dy)) {
        return dx < 0 ? "left" : "right";
    }

    return dy < 0 ? "up" : "down";
}

function sensor_gyro_magnitude(gyro) {
    if (!gyro) {
        return 0;
    }

    const x = Number(gyro.x);
    const y = Number(gyro.y);
    const z = Number(gyro.z);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return 0;
    }

    return Math.sqrt(x * x + y * y + z * z);
}

function sensor_process_gyro(gyro) {
    const magnitude = sensor_gyro_magnitude(gyro);
    const now = performance.now();

    if (!_sensor_gyro_armed) {
        if (magnitude < GYRO_REARM_DPS) {
            _sensor_gyro_armed = true;
        }
        return;
    }

    if (magnitude >= GYRO_TRIGGER_DPS &&
        now - _sensor_last_gyro_hit >= GYRO_COOLDOWN_MS) {
        _sensor_gyro_armed = false;
        _sensor_last_gyro_hit = now;
        sensor_trigger_lane("gyro");
    }
}

function sensor_trigger_joystick() {
    const now = performance.now();

    if (now - _sensor_last_joystick_hit < JOYSTICK_COOLDOWN_MS) {
        return false;
    }

    _sensor_last_joystick_hit = now;
    sensor_trigger_lane("joystick");
    return true;
}

function sensor_process_joystick(previous, current) {
    if (!current) {
        return;
    }

    const direction = sensor_joystick_direction(current);

    if (direction === null) {
        _sensor_joystick_direction = null;
    } else if (direction !== _sensor_joystick_direction) {
        if (sensor_trigger_joystick()) {
            _sensor_joystick_direction = direction;
        }
    }

    if (current.button && !(previous && previous.button)) {
        sensor_trigger_joystick();
    }
}

function sensor_prime(state) {
    // Don't count a sensor that is already active when the page loads or
    // reconnects. It must be released and triggered again.
    _sensor_gyro_armed =
        sensor_gyro_magnitude(state.gyro) < GYRO_TRIGGER_DPS;
    _sensor_joystick_direction = sensor_joystick_direction(state.joystick);
}

function sensor_process_state(state) {
    const previous = _sensor_previous;
    _sensor_previous = state;

    if (previous === null) {
        sensor_prime(state);
        return;
    }

    if (state.touch && !previous.touch) {
        sensor_trigger_lane("touch");
    }

    if (state.sonic && !previous.sonic) {
        sensor_trigger_lane("sonic");
    }

    sensor_process_joystick(previous.joystick, state.joystick);
    sensor_process_gyro(state.gyro);
}

function sensor_set_status(online) {
    if (online) {
        if (window.SENSOR_STATUS !== "online") {
            console.info("[sensors] connected: " + SENSOR_API_URL);
        }
        window.SENSOR_STATUS = "online";
        _sensor_offline_logged = false;
        return;
    }

    if (!_sensor_offline_logged) {
        console.warn(
            "[sensors] offline; keyboard 1-4 still works: " + SENSOR_API_URL
        );
        _sensor_offline_logged = true;
    }
    window.SENSOR_STATUS = "offline";
}

async function sensor_poll() {
    if (_sensor_stopped) {
        return;
    }

    const started_at = performance.now();
    let online = false;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(function () {
            controller.abort();
        }, SENSOR_TIMEOUT_MS);

        try {
            // The backend already sends Cache-Control: no-store; keeping this
            // a plain GET avoids an unnecessary CORS preflight.
            const response = await fetch(SENSOR_API_URL, {
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }

            const state = await response.json();

            if (!state || typeof state !== "object") {
                throw new Error("invalid sensor state");
            }

            online = true;
            sensor_set_status(true);
            sensor_process_state(state);
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        // Drop the old snapshot so the next good read primes instead of
        // firing an edge for a gesture that happened while disconnected.
        _sensor_previous = null;
        sensor_set_status(false);
    } finally {
        if (_sensor_stopped) {
            return;
        }

        const elapsed = performance.now() - started_at;
        const delay = online
            ? Math.max(0, SENSOR_POLL_MS - elapsed)
            : SENSOR_RETRY_MS;

        _sensor_poll_timer = setTimeout(sensor_poll, delay);
    }
}

window.addEventListener("pagehide", function () {
    _sensor_stopped = true;

    if (_sensor_poll_timer !== null) {
        clearTimeout(_sensor_poll_timer);
        _sensor_poll_timer = null;
    }
});

// Resume polling if the page comes back from the back/forward cache.
window.addEventListener("pageshow", function () {
    if (_sensor_stopped) {
        _sensor_stopped = false;
        sensor_poll();
    }
});

sensor_poll();
