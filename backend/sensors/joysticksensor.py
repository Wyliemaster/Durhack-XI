"""Analog joystick through an ADS7830 ADC.

The joystick axes are read as raw 8-bit values (0-255) from two ADS7830
channels. The switch is a GPIO input with an external pull-up.
"""

import logging
import os
import threading
import time

import config

# Must be set before gpiozero is imported. This also lets the user override it.
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_bus = None
_button = None
_last_error_log = 0.0


def init():
    """Open the ADS7830 and create the joystick switch input."""
    global _bus, _button

    if _bus is not None and _button is not None:
        return

    from gpiozero import Button
    from smbus2 import SMBus

    bus = None
    button = None
    try:
        bus = SMBus(config.JOYSTICK_I2C_BUS)
        # Test that the ADC responds at the configured address.
        bus.read_byte_data(
            config.JOYSTICK_I2C_ADDRESS,
            _channel_command(config.JOYSTICK_X_CHANNEL),
        )

        button = Button(
            config.JOYSTICK_BUTTON_PIN,
            pull_up=None,
            active_state=not config.JOYSTICK_BUTTON_ACTIVE_LOW,
            bounce_time=config.JOYSTICK_BUTTON_BOUNCE_S,
        )
    except Exception as exc:
        if button is not None:
            try:
                button.close()
            except Exception:
                pass
        if bus is not None:
            try:
                bus.close()
            except Exception:
                pass
        raise RuntimeError(
            "Could not initialise the joystick. Check the ADS7830 wiring and "
            f"address (configured 0x{config.JOYSTICK_I2C_ADDRESS:02X}), the "
            "switch wiring, and that I2C is enabled."
        ) from exc

    with _lock:
        _bus = bus
        _button = button

    logger.info(
        "Joystick ready: ADS7830 at 0x%02X on I2C bus %d, switch=GPIO%d (%s)",
        config.JOYSTICK_I2C_ADDRESS,
        config.JOYSTICK_I2C_BUS,
        config.JOYSTICK_BUTTON_PIN,
        "active-low" if config.JOYSTICK_BUTTON_ACTIVE_LOW else "active-high",
    )


def cleanup():
    """Close the ADC bus and the switch input."""
    global _bus, _button

    with _lock:
        button = _button
        bus = _bus
        _button = None
        _bus = None

    if button is not None:
        try:
            button.close()
        except Exception:
            logger.exception("Failed to close the joystick switch")
    if bus is not None:
        try:
            bus.close()
        except Exception:
            logger.exception("Failed to close the ADS7830 I2C bus")

    logger.info("Joystick released")


def read_axes():
    """Return the raw ADC values for the joystick axes."""
    with _lock:
        if _bus is None:
            raise RuntimeError("Joystick has not been initialised")

        try:
            x = _read_channel(config.JOYSTICK_X_CHANNEL)
            y = _read_channel(config.JOYSTICK_Y_CHANNEL)
        except Exception:
            _log_read_error()
            return {"x": 0, "y": 0}

        logger.debug("joystick x=%d y=%d", x, y)
        return {"x": x, "y": y}


def is_pressed():
    """Return True while the joystick switch is pressed."""
    with _lock:
        if _button is None:
            raise RuntimeError("Joystick has not been initialised")

        try:
            pressed = bool(_button.is_pressed)
        except Exception:
            _log_read_error()
            return False

        logger.debug("joystick button=%s", pressed)
        return pressed


def read():
    """Return {'joystick': {'x': ..., 'y': ..., 'button': ...}}."""
    axes = read_axes()
    return {
        "joystick": {
            "x": axes["x"],
            "y": axes["y"],
            "button": is_pressed(),
        }
    }


def _read_channel(channel):
    command = _channel_command(channel)
    return _bus.read_byte_data(config.JOYSTICK_I2C_ADDRESS, command)


def _channel_command(channel):
    # ADS7830 single-ended command: 0x84 base plus the channel bits.
    return 0x84 | ((((channel << 2) | (channel >> 1)) & 0x07) << 4)


def _log_read_error():
    global _last_error_log

    now = time.monotonic()
    if now - _last_error_log >= 1.0:
        logger.exception("Joystick read failed; reporting neutral values")
        _last_error_log = now
