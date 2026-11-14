"""Direct HC-SR04 and touch sensor access.

The HTTP endpoint calls read_state() for every request. A module-level lock
serialises access because the HC-SR04 trigger/echo pins cannot be shared by
two overlapping reads.

The HC-SR04 is read manually instead of using gpiozero.DistanceSensor:
DistanceSensor keeps a background 60 ms median queue and ignores readings
where no echo was received. For a fast trigger that must release reliably
when the hand moves away, a direct read is easier to reason about.
"""

import logging
import os
import threading
import time

import config

# Must be set before gpiozero is imported. This also lets the user override it.
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")

logger = logging.getLogger(__name__)

_SPEED_OF_SOUND_CM_S = 34300.0
_ECHO_TIMEOUT_S = 2.0 * config.SONIC_MAX_DISTANCE_M / 343.0 + 0.01

_lock = threading.Lock()
_sonic = False
_trigger = None
_echo = None
_touch = None
_echo_event = threading.Event()
_echo_rise = None
_echo_fall = None
_last_error_log = 0.0


def init():
    """Create the GPIO devices. Called once from main()."""
    global _trigger, _echo, _touch

    if _trigger is not None:
        return

    from gpiozero import Button, InputDevice, OutputDevice

    trigger = None
    echo = None
    touch = None
    try:
        trigger = OutputDevice(config.SONIC_TRIG_PIN, initial_value=False)

        # A pull-down keeps ECHO low if the sensor is disconnected; the sensor
        # drives the line normally when it is connected.
        echo = InputDevice(config.SONIC_ECHO_PIN, pull_up=False)
        echo.pin.edges = "both"
        echo.pin.when_changed = _echo_changed

        touch = Button(
            config.TOUCH_PIN,
            pull_up=config.TOUCH_ACTIVE_LOW,
            bounce_time=config.TOUCH_BOUNCE_S,
        )
    except Exception as exc:
        if echo is not None and echo.pin is not None:
            try:
                echo.pin.when_changed = None
            except Exception:
                pass
        for device in (trigger, echo, touch):
            if device is not None:
                try:
                    device.close()
                except Exception:
                    pass
        raise RuntimeError(
            "Could not initialise the GPIO sensors. Check the wiring and pin "
            "numbers, and make sure lgpio is available."
        ) from exc

    with _lock:
        _trigger = trigger
        _echo = echo
        _touch = touch

    logger.info(
        "Sensors ready: HC-SR04 trigger=GPIO%d echo=GPIO%d, touch=GPIO%d (%s)",
        config.SONIC_TRIG_PIN,
        config.SONIC_ECHO_PIN,
        config.TOUCH_PIN,
        "active-low" if config.TOUCH_ACTIVE_LOW else "active-high",
    )
    logger.info(
        "Sonic threshold: trigger <= %.1f cm, release >= %.1f cm",
        config.SONIC_TRIGGER_CM,
        config.SONIC_RELEASE_CM,
    )


def cleanup():
    """Close the GPIO devices and release the pins."""
    global _trigger, _echo, _touch

    with _lock:
        if _echo is not None and _echo.pin is not None:
            try:
                _echo.pin.when_changed = None
            except Exception:
                pass

        for device in (_trigger, _echo, _touch):
            if device is not None:
                try:
                    device.close()
                except Exception:
                    logger.exception("Failed to close a sensor device")

        _trigger = None
        _echo = None
        _touch = None

    logger.info("GPIO released")


def read_state():
    """Read both sensors and return {'sonic': bool, 'touch': bool}."""
    global _sonic

    with _lock:
        if _trigger is None or _echo is None or _touch is None:
            raise RuntimeError("Sensors have not been initialised")

        distance_cm = None
        try:
            distance_cm = _read_distance_cm()
            if distance_cm is None:
                _sonic = False
            elif distance_cm <= config.SONIC_TRIGGER_CM:
                _sonic = True
            elif distance_cm >= config.SONIC_RELEASE_CM:
                _sonic = False
        except Exception:
            _sonic = False
            _log_read_error()

        try:
            touch = bool(_touch.is_pressed)
        except Exception:
            touch = False
            _log_read_error()

        logger.debug(
            "distance=%s sonic=%s touch=%s",
            "no echo" if distance_cm is None else f"{distance_cm:.1f}cm",
            _sonic,
            touch,
        )
        return {"sonic": bool(_sonic), "touch": touch}


def read_sonic_distance_cm():
    """Read the HC-SR04 once and return centimetres, or None on no echo."""
    with _lock:
        if _trigger is None or _echo is None:
            raise RuntimeError("Sensors have not been initialised")
        return _read_distance_cm()


def read_touch():
    """Return True while the touch sensor is pressed."""
    with _lock:
        if _touch is None:
            raise RuntimeError("Sensors have not been initialised")
        return bool(_touch.is_pressed)


def _echo_changed(ticks, level):
    global _echo_rise, _echo_fall

    if level:
        _echo_rise = ticks
    else:
        _echo_fall = ticks
        _echo_event.set()


def _read_distance_cm():
    global _echo_rise, _echo_fall

    # A previous echo should have finished before the next trigger. If the
    # line is still high, wait briefly so the new pulse starts cleanly.
    if _echo.value:
        deadline = time.monotonic() + 0.05
        while _echo.value:
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.001)

    # Give any delayed edge callback from the previous pulse time to run.
    time.sleep(0.001)

    _echo_event.clear()
    _echo_rise = None
    _echo_fall = None

    _trigger.on()
    try:
        time.sleep(0.00001)
    finally:
        _trigger.off()

    if not _echo_event.wait(_ECHO_TIMEOUT_S):
        return None

    rise = _echo_rise
    fall = _echo_fall
    if rise is None or fall is None:
        return None

    pulse_s = _echo.pin_factory.ticks_diff(fall, rise)
    if pulse_s <= 0:
        return None

    distance_cm = pulse_s * _SPEED_OF_SOUND_CM_S / 2.0
    if distance_cm > config.SONIC_MAX_DISTANCE_M * 100.0:
        return None
    return distance_cm


def _log_read_error():
    global _last_error_log

    now = time.monotonic()
    if now - _last_error_log >= 1.0:
        logger.exception("Sensor read failed; reporting false")
        _last_error_log = now
