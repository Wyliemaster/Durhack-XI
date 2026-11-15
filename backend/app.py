"""HTTP API for the Durhack XI sensor backend."""

import logging

from flask import Flask, jsonify
from flask_cors import CORS

import config
from sensors import sensor_controller

app = Flask(__name__)
CORS(app, resources={r"/sensors_state": {"origins": "*"}})


@app.get("/sensors_state")
def sensors_state():
    try:
        state = sensor_controller.get_sensor_state()
    except RuntimeError as exc:
        response = jsonify({"error": str(exc)})
        response.headers["Cache-Control"] = "no-store"
        return response, 503

    response = jsonify(state)
    response.headers["Cache-Control"] = "no-store"
    return response


def main():
    logging.basicConfig(
        level=config.LOG_LEVEL,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # The frontend polls at 20 Hz; don't log every request.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    logger = logging.getLogger("sensor_api")

    try:
        config.validate()
    except ValueError as exc:
        raise SystemExit(f"Configuration error: {exc}") from exc

    try:
        sensor_controller.init()
    except Exception as exc:
        logger.exception("Sensor startup failed")
        raise SystemExit(f"Sensor startup failed: {exc}") from exc

    if config.HOST == "0.0.0.0":
        logger.info(
            "Serving GET /sensors_state on port %d; use the Pi's IP from other devices",
            config.PORT,
        )
    else:
        logger.info(
            "Serving GET /sensors_state on http://%s:%d",
            config.HOST,
            config.PORT,
        )

    try:
        app.run(
            host=config.HOST,
            port=config.PORT,
            debug=False,
            use_reloader=False,
            threaded=True,
        )
    except OSError as exc:
        raise SystemExit(f"Could not start the HTTP server: {exc}") from exc
    finally:
        sensor_controller.cleanup()


if __name__ == "__main__":
    main()
