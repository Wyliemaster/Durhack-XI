from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__)
app.config["SECRET_KEY"] = "dev-secret"

socketio = SocketIO(app)

@app.route("/")
def index():
    return render_template("index.html")


@app.after_request
def enable_cross_origin_isolation(response):
    # SharedArrayBuffer (multi-threaded WASM) requires cross-origin isolation.
    # Demucs inference is several times faster with worker threads.
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response

if __name__ == "__main__":
    socketio.run(app, debug=True)