const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const stage = document.querySelector(".stage");

const CHANNELS = 4;
const CHANNEL_COLOURS = ["#E566B0", "#8DE2CC", "#81F0FF", "#CEE765"];
const CHANNEL_GLYPHS = ["dot", "bar", "diamond", "triangle"];
const CHANNEL_DARK = ["#8f2a5f", "#3f8f7d", "#2c93a3", "#7c8d2e"];
const CHANNEL_LIGHT = ["#ffb3dc", "#c9fff0", "#c4fbff", "#f2ff9e"];
const TITLE_BOUNDARY = 220;

const UI_FONT = '"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_FONT = 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace';
const DISPLAY_FONT = '"Audiowide", "Space Grotesk", system-ui, sans-serif';

// Logical canvas resolutions; portrait swaps the two
const CANVAS_LONG = 1920;
const CANVAS_SHORT = 1080;

var score = 0;
var tick = 0;
var last_time = performance.now();
var current_orientation = "portrait";

// Returns the time elapsed since the last call, in seconds.
// Clamped so a backgrounded tab doesn't produce one huge jump on return.
const MAX_DELTA_TIME = 0.1; // 100ms

// Debug input: when true, keys 1-4 trigger channels 0-3 directly
const DEBUG_INPUT_ENABLED = true;

// Sound effects for hits and misplays
const SOUND_ENABLED = true;
const HIT_VOLUME = 0.02;
const MISS_VOLUME = 0.02;
const HIT_CLICK_VOLUME = 0.045;

// Each channel uses its own instrument timbre for hit/miss feedback.
const CHANNEL_SOUND_STYLES = ["drums", "bass", "guitar", "piano"];
const CHANNEL_FREQUENCIES = [0, 55.00, 146.83, 523.25];

var audio_context = null;
var audio_master = null;
var pluck_cache = new Map();
var hit_buffer_cache = new Map();
var hit_click_buffer = null;

// How much lanes/notes shrink at the far (vanishing-point) end
const FAR_SCALE = 0.15;

// Near-edge lane width multiplier (1 = lanes fill the canvas exactly)
const LANE_WIDTH_SCALE = 1.0;

class Note {
    constructor(channel, speed, hit_time = null) {
        this.channel = channel;
        this.speed = speed;
        this.hit_time = hit_time; // song time this note should reach the circle
        this.travel_time = hit_time === null ? 0 : get_travel_length() / speed;
        this.t = 0; // 0 = far edge, 1 = at the hit circle
    }

    update(delta_time) {
        if (this.hit_time !== null) {
            // Drive the note from the song clock rather than accumulating
            // frame deltas, so dropped frames cannot desync it from the music.
            if (this.travel_time > 0) {
                const target_t = 1 - (this.hit_time - get_song_time()) / this.travel_time;
                const base_step = delta_time / this.travel_time;

                this.t += base_step;

                // Correct any difference between where the note is and where
                // it needs to be with a bounded speed change.
                const error = target_t - this.t;

                if (Math.abs(error) > NOTE_SYNC_SNAP) {
                    this.t = target_t;
                } else {
                    const max_correction = NOTE_SYNC_MAX_CORRECTION * delta_time;
                    this.t += Math.max(-max_correction, Math.min(max_correction, error));
                }
            }
            return;
        }

        const travel = get_travel_length();
        if (travel > 0) {
            this.t += (this.speed * delta_time) / travel;
        }
    }

    // Geometry is derived from the current canvas size so it adapts
    // automatically when the orientation changes.
    get lane_extent() {
        return get_lane_extent();
    }

    get depth_scale() {
        return get_lane_point(this.channel, this.t).scale;
    }

    get width() {
        // Portrait notes fall downwards, so they're stretched vertically
        const base = is_portrait() ? this.lane_extent / 2 : this.lane_extent / 2 * 1.5;
        return base * this.depth_scale;
    }

    get height() {
        const base = is_portrait() ? this.lane_extent / 2 * 1.25 : this.lane_extent / 2;
        return base * this.depth_scale;
    }

    // Direction of the lane, so notes lean with the perspective
    get angle() {
        return get_lane_angle(this.channel);
    }

    hits_circle(cx, cy, radius) {
        const point = get_lane_point(this.channel, this.t);
        const angle = this.angle;

        // Put the circle into the note's local (unrotated) space
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);
        const dx = cx - point.x;
        const dy = cy - point.y;
        const local_x = dx * cos - dy * sin;
        const local_y = dx * sin + dy * cos;

        const half_width = this.width / 2;
        const half_height = this.height / 2;
        const nearest_x = Math.max(-half_width, Math.min(local_x, half_width));
        const nearest_y = Math.max(-half_height, Math.min(local_y, half_height));
        const gap_x = local_x - nearest_x;
        const gap_y = local_y - nearest_y;

        return gap_x * gap_x + gap_y * gap_y <= radius * radius;
    }

    draw()
    {
        const point = get_lane_point(this.channel, this.t);

        // Fade notes out as they pass the hit circles into the bottom fade
        let alpha = 1;
        if (is_portrait()) {
            const fade_start = canvas.height * 0.88;
            const fade_end = canvas.height * 0.93;
            if (point.y > fade_start) {
                alpha = Math.max(0, 1 - (point.y - fade_start) / (fade_end - fade_start));
            }
        } else {
            const fade_start = canvas.width * 0.05;
            const fade_end = canvas.width * 0.025;
            if (point.x < fade_start) {
                alpha = Math.max(0, (point.x - fade_end) / (fade_start - fade_end));
            }
        }

        // Short ghost trail, then the pick itself.
        draw_note_at(this.channel, this.t - 0.018, alpha * 0.16, 0.98);
        draw_note_at(this.channel, this.t - 0.036, alpha * 0.07, 0.96);
        draw_note_at(this.channel, this.t, alpha, 1);
    }
};

function draw_note_at(channel, t, alpha, size_scale = 1) {
    const sprite = note_sprites[channel];
    if (!sprite) {
        return;
    }

    const point = get_lane_point(channel, t);
    const lane_extent = get_lane_extent();
    const base_width = (is_portrait() ? lane_extent / 2 : lane_extent / 2 * 1.5) * 1.12;
    const base_height = (is_portrait() ? lane_extent / 2 * 1.25 : lane_extent / 2) * 1.12;
    const across = base_width * point.scale * size_scale;
    const along = base_height * point.scale * size_scale;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(point.x, point.y);
    // Landscape lanes travel left, so the pick is turned to match.
    ctx.rotate(get_lane_angle(channel) + (is_portrait() ? 0 : -Math.PI / 2));
    ctx.drawImage(sprite, -across / 2, -along / 2, across, along);
    ctx.restore();
}

var active_notes = [];
var spawn_interval = 1; // minimum seconds between notes (updated from the tempo)
var spawn_timer = 0;

// Song used to drive note spawning
const SONG_VOLUME = 0.6;
const NOTE_SPEED = 200; // fallback speed, px per second in lane space
const LEAD_BEATS = 4;   // notes take this many beats to reach the circles
const MIN_NOTE_GAP = 0.35; // never spawn notes closer together than this (seconds)

// Optional Demucs ONNX stem separation. Place htdemucs.onnx in static/models/.
// If the model or onnxruntime-web is unavailable, the game falls back to
// analyzing the full mix.
const DEMUCS_ENABLED = true;
const DEMUCS_MODEL_URL = "/static/models/htdemucs.onnx";
const DEMUCS_ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.min.js";
const DEMUCS_SAMPLE_RATE = 44100;
const DEMUCS_SEGMENT_SECONDS = 7.8;
const DEMUCS_STEM_NAMES_4 = ["drums", "bass", "other", "vocals"];
const DEMUCS_STEM_NAMES_6 = ["drums", "bass", "other", "vocals", "guitar", "piano"];
const DESIRED_INSTRUMENTS = [
    { name: "drums", channel: 0, stem4: 0, stem6: 0 },
    { name: "bass", channel: 1, stem4: 1, stem6: 1 },
    { name: "electric guitar", channel: 2, stem4: 2, stem6: 4 },
    { name: "piano/keyboard", channel: 3, stem4: null, stem6: 5, prefer: "other" }
];
const INSTRUMENT_LABELS = ["DRUMS", "BASS", "GUITAR", "PIANO"];
const INSTRUMENT_LABEL_COLOURS = ["#E566B0", "#8DE2CC", "#81F0FF", "#CEE765"];

// Per-channel minimum spacing. Instrument onsets are used directly, so the
// old global 0.35 s beat grid would throw away fast bass/guitar phrases.
// Drums stay sparse (kick/snare), while lead instruments keep their attacks.
const INSTRUMENT_MIN_GAP = [0.5, 0.46, 0.44, 0.5];

// Onset peak-picking for separated stems.
const DEMUCS_RAW_MIN_GAP = 0.12;
const DEMUCS_ONSET_FACTOR = 1.8;
const DEMUCS_ONSET_FLOOR = 0.05;
const DEMUCS_ACTIVE_RATIO = 0.01;
const DEMUCS_PIANO_ACTIVE_RATIO = 0.02;
const DEMUCS_HIGH_BAND_MIN_FRACTION = 0.15;
const DEMUCS_PIANO_MIN_HIGH_FRACTION = 0.2;
const DEMUCS_FALLBACK_DEDUPE = 0.06;

// When false, a channel whose instrument is absent stays empty. This avoids
// a "piano" lane playing bass/drum bleed when the song has no piano.
const FALLBACK_MISSING_INSTRUMENTS = false;

// Portable note-map file written by the Save map button and accepted by
// Load song.
const NOTE_MAP_FORMAT = "durhack-dmap";
const NOTE_MAP_LEGACY_FORMAT = "durhack-note-map";
const NOTE_MAP_VERSION = 1;

var beat_interval = 0.5; // seconds per beat, updated by analysis

// Manual calibration: positive values delay notes relative to the music
var sync_offset = 0;
try {
    sync_offset = parseFloat(localStorage.getItem("durhack_sync_offset")) || 0;
} catch (error) {
    sync_offset = 0;
}
sync_offset = Math.max(-0.5, Math.min(0.5, sync_offset));

// Change the global sync offset and retarget notes already in flight. The
// note motion controller then speeds them up or slows them down to converge.
function set_sync_offset(new_offset) {
    new_offset = Math.max(-0.5, Math.min(0.5, new_offset));
    const delta = new_offset - sync_offset;

    if (delta === 0) {
        return;
    }

    sync_offset = new_offset;

    for (let i = 0; i < active_notes.length; i++) {
        if (active_notes[i].hit_time !== null) {
            active_notes[i].hit_time += delta;
        }
    }

    try {
        localStorage.setItem("durhack_sync_offset", String(sync_offset));
    } catch (error) {
        // Storage may be unavailable; ignore
    }
}

var song_started = false;
var song_starting = false;
var song_loading = false;
var beats_loaded = false;
var selected_beats = [];
var beat_index = 0;

var song_buffer = null;
var song_source = null;
var song_gain = null;
var song_start_time = 0;
var lane_source_names = [];
var lane_fallback_flags = [];

var demucs_ort = null;
var demucs_session = null;
var demucs_unavailable = false;
var demucs_running = false;
var pending_note_map = null;
var current_song_info = null;
var current_instrument_map = null;
var current_song_blob = null;
var editor_mode = false;
var manual_notes = [];

// ---- Combo, celebration and sprite state ----
var combo = 0;
var max_combo = 0;
var last_milestone = 0;
var last_miss_shown_at = 0;
var last_celebration_at = 0;
var attempt_broken = false;
var finish_banner = null;
var best_score = 0;
var note_sprites = [];
var dino_sprites = {};
var effects_enabled = true;
var dino_hide_timers = { left: null, right: null };

const FX_STORAGE_KEY = "durhack-fx";
const BEST_SCORE_KEY = "durhack-best";

const MILESTONES = [
    { at: 10, side: "left", text: "LGTM", sound: "blip" },
    { at: 25, side: "right", text: "NO MERGE CONFLICTS", sound: "arp" },
    { at: 50, side: "left", text: "SHIP IT", sound: "arp", hop: true, confetti: true },
    { at: 75, side: "right", text: "WORKS ON MY MACHINE", sound: "arp" },
    { at: 100, side: "both", text: "PRODUCTION READY", sound: "horn", glow: true, confetti: true }
];

const MILESTONE_JOKES = [
    "IT COMPILES",
    "NO REGRESSIONS",
    "MERGED TO MAIN",
    "ALL TESTS PASS",
    "HOTFIX DEPLOYED",
    "DEPLOYED ON FRIDAY"
];

const MISS_MESSAGES = ["SEGFAULT", "MERGE CONFLICT", "404 NOTE NOT FOUND"];

// The mascots are composed as a chunky pixel buffer (see build_dino_buffer)
// so the silhouette, muzzle and accessories stay crisp at any dino size.
const DINO_WIDTH = 36;
const DINO_HEIGHT = 40;

const DINO_PALETTES = {
    mint: {
        P: "#8DE2CC",
        d: "#4FAE95",
        L: "#D9FFF6",
        W: "#FAFAFA",
        M: "#611545",
        T: "#E566B0",
        K: "#0d0710",
        A: "#4E79A1"
    },
    pink: {
        P: "#E566B0",
        d: "#B03E7E",
        L: "#F7A9D8",
        W: "#FAFAFA",
        M: "#611545",
        T: "#EF6FB4",
        K: "#0d0710",
        A: "#CEE765"
    }
};

var effects = [];
const EFFECT_DURATION = 0.5; // seconds
const FIRE_COLORS = ["#fff3a0", "#ffd23f", "#ff9f1c", "#ff5e00"];
const EFFECT_PARTICLES = 80;

// Pre-rendered glow sprites and reusable particle objects. Drawing a cached
// image is far cheaper than building an arc path for every particle.
const PARTICLE_SPRITE_SIZE = 64;
var particle_sprite_cache = {};
var particle_pool = [];
var effect_pool = [];

// How long a hit circle stays filled after being pressed
const CIRCLE_FLASH_DURATION = 0.15; // seconds

// How long a successful hit keeps its hit circle enlarged
const CIRCLE_HIT_DURATION = 0.18; // seconds
const CIRCLE_HIT_SCALE = 0.30;

// How close (in seconds) a press must be to the note's centre reaching the
// circle centre. Wider = more forgiving.
const HIT_WINDOW = 0.22;

// Predictive speed correction: if a note's projected arrival drifts from its
// target, it speeds up/slows down to converge instead of teleporting.
const NOTE_SYNC_MAX_CORRECTION = 0.6; // t units per second
const NOTE_SYNC_SNAP = 0.35;          // larger errors snap to the target

var circle_flash_timers = new Array(CHANNELS).fill(0);
var circle_hit_timers = new Array(CHANNELS).fill(0);

// How much a hit circle is squashed along the lane's depth axis
const CIRCLE_PERSPECTIVE = 0.7;

function set_orientation(orientation) {
    // With no argument, toggle to the opposite orientation
    if (orientation !== "portrait" && orientation !== "landscape") {
        orientation = current_orientation === "landscape" ? "portrait" : "landscape";
    }

    const changed = orientation !== current_orientation;
    current_orientation = orientation;

    if (orientation === "portrait") {
        canvas.width = CANVAS_SHORT;
        canvas.height = CANVAS_LONG;
    } else {
        canvas.width = CANVAS_LONG;
        canvas.height = CANVAS_SHORT;
    }

    stage.classList.toggle("portrait", orientation === "portrait");
    stage.classList.toggle("landscape", orientation === "landscape");
    document.body.classList.toggle("portrait", orientation === "portrait");
    document.body.classList.toggle("landscape", orientation === "landscape");

    // In-flight notes have coordinates tied to the old orientation
    if (changed) {
        active_notes.length = 0;
        clear_effects();
        spawn_timer = 0;
    }

    fit_canvas_to_viewport();
}

// Scales the CSS size of the canvas down to fit the window while keeping
// the logical (attribute) resolution and aspect ratio intact.
function fit_canvas_to_viewport() {
    // Leave room for the normal-flow header. Narrow screens wrap the
    // controls onto a second row, so the canvas shrinks a little more.
    const height_factor = window.innerWidth < 980 ? 0.78 : 0.86;
    const max_width = window.innerWidth * 0.98;
    const max_height = window.innerHeight * height_factor;
    const scale = Math.min(max_width / canvas.width, max_height / canvas.height);

    canvas.style.width = Math.floor(canvas.width * scale) + "px";
    canvas.style.height = Math.floor(canvas.height * scale) + "px";
}

window.addEventListener("resize", fit_canvas_to_viewport);

function is_portrait() {
    return current_orientation === "portrait";
}

function get_lane_height() {
    return (canvas.height - TITLE_BOUNDARY) / CHANNELS;
}

// Size of a lane along the axis the notes travel on:
// vertical lanes in portrait, horizontal lanes in landscape.
function get_lane_extent() {
    const base = is_portrait() ? canvas.width / CHANNELS : get_lane_height();
    return base * LANE_WIDTH_SCALE;
}

// Near-edge centre of a channel (x in portrait, y in landscape)
function get_lane_center(channel) {
    if (is_portrait()) {
        const base = canvas.width / CHANNELS;
        return canvas.width / 2 + (base * (channel + 0.5) - canvas.width / 2) * LANE_WIDTH_SCALE;
    }

    const base = get_lane_height();
    const base_y = TITLE_BOUNDARY + base * (channel + 0.5);
    return canvas.height / 2 + (base_y - canvas.height / 2) * LANE_WIDTH_SCALE;
}

function get_circle_radius() {
    return get_lane_extent() / 3;
}

// Hit targets sit on the left in landscape and along the bottom in portrait.
function get_circle_center(channel) {
    if (is_portrait()) {
        return {
            x: get_lane_center(channel),
            y: canvas.height - get_circle_radius() - canvas.height * 0.07
        };
    }

    return {
        x: get_lane_height() / 2,
        y: get_lane_center(channel)
    };
}

function get_travel_length() {
    if (is_portrait()) {
        return get_circle_center(0).y - TITLE_BOUNDARY;
    }
    return canvas.width - get_circle_center(0).x;
}

// Screen angle of a lane, used to align notes and hit circles with the plane
function get_lane_angle(channel) {
    const far = get_lane_point(channel, 0);
    const near = get_lane_point(channel, 1);
    const dx = near.x - far.x;
    const dy = near.y - far.y;
    return is_portrait() ? Math.atan2(-dx, dy) : Math.atan2(dy, dx);
}

// Point along a lane at depth t: 0 = far (vanishing) end, 1 = hit circle.
// Also returns the size multiplier used to fake perspective.
function get_lane_point(channel, t) {
    if (is_portrait()) {
        const near_x = get_lane_center(channel);
        const far_x = canvas.width / 2 + (near_x - canvas.width / 2) * FAR_SCALE;
        const near_y = get_circle_center(channel).y;

        return {
            x: far_x + (near_x - far_x) * t,
            y: TITLE_BOUNDARY + (near_y - TITLE_BOUNDARY) * t,
            scale: FAR_SCALE + (1 - FAR_SCALE) * t
        };
    }

    const near_y = get_lane_center(channel);
    const far_y = canvas.height / 2 + (near_y - canvas.height / 2) * FAR_SCALE;
    const near_x = get_circle_center(channel).x;

    return {
        x: canvas.width + (near_x - canvas.width) * t,
        y: far_y + (near_y - far_y) * t,
        scale: FAR_SCALE + (1 - FAR_SCALE) * t
    };
}

function get_delta_time() {
    let now = performance.now();
    let delta_time = (now - last_time) / 1000;
    last_time = now;
    return Math.min(delta_time, MAX_DELTA_TIME);
}

function draw_circle(x, y, radius, fill_colour = null, fill_alpha = 1, channel = 0)
{
    const inactive = lane_source_names.length > 0 &&
        lane_source_names[channel] === null;
    const colour = inactive ? "#8b8b96" : CHANNEL_COLOURS[channel];
    const flash = fill_colour ? fill_alpha : 0;
    const hit = Math.max(
        0,
        Math.min(1, circle_hit_timers[channel] / CIRCLE_HIT_DURATION)
    );
    const pulse = 1 + CIRCLE_HIT_SCALE * hit;

    const ellipse = function (rx, ry) {
        ctx.beginPath();

        if (is_portrait()) {
            ctx.ellipse(x, y, rx, ry * CIRCLE_PERSPECTIVE, 0, 0, 2 * Math.PI);
        } else {
            ctx.ellipse(x, y, rx * CIRCLE_PERSPECTIVE, ry, 0, 0, 2 * Math.PI);
        }
    };

    ctx.save();

    // Outer halo
    ellipse(radius * 1.2 * pulse, radius * 1.2 * pulse);
    ctx.globalAlpha = inactive ? 0.12 : 0.16 + flash * 0.34;
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(4, radius * 0.14);
    ctx.stroke();

    // Dark gap between the two rings
    ellipse(radius * pulse, radius * pulse);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#0d0710";
    ctx.lineWidth = Math.max(5, radius * 0.16);
    ctx.stroke();

    // Bright inner ring
    ellipse(radius * 0.9 * pulse, radius * 0.9 * pulse);
    ctx.globalAlpha = inactive ? 0.35 : 0.88;
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(3, radius * 0.09);
    ctx.stroke();

    // Hit flash fill
    if (flash > 0) {
        ellipse(radius * 0.82 * pulse, radius * 0.82 * pulse);
        ctx.globalAlpha = flash * 0.4;
        ctx.fillStyle = colour;
        ctx.fill();
    }

    ctx.restore();
}

// Instrument names sit just outside the hit circles so each lane's role is
// visible without cluttering the note path.
function draw_instrument_labels() {
    const radius = get_circle_radius();
    const base_font_size = Math.max(20, Math.round(radius * 0.33));

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const show_instruments = song_buffer === null || lane_source_names.length > 0;
    const label_names = show_instruments
        ? INSTRUMENT_LABELS
        : ["LANE 1", "LANE 2", "LANE 3", "LANE 4"];

    for (let i = 0; i < CHANNELS; i++) {
        const circle = get_circle_center(i);
        const source = lane_source_names[i];
        let label = label_names[i];

        if (source && lane_fallback_flags[i]) {
            label += "\u2192" + String(source).toUpperCase();
        } else if (!source && lane_source_names.length > 0) {
            label += "\u2014";
        }

        const font_size = label.length > 7
            ? Math.max(16, Math.round(base_font_size * 0.78))
            : base_font_size;
        const box_height = font_size + 12;
        const label_y = is_portrait()
            ? circle.y + radius * CIRCLE_PERSPECTIVE + box_height * 0.75
            : circle.y - radius - box_height * 0.75;

        ctx.font = "700 " + font_size + "px Arial";

        const text_width = ctx.measureText(label).width;
        const box_width = text_width + font_size * 0.9;
        const box_x = circle.x - box_width / 2;
        const box_y = label_y - box_height / 2;
        const active = lane_source_names.length === 0 || source !== null;

        ctx.fillStyle = "rgba(10, 10, 12, 0.62)";
        ctx.beginPath();

        if (typeof ctx.roundRect === "function") {
            ctx.roundRect(box_x, box_y, box_width, box_height, 8);
        } else {
            ctx.rect(box_x, box_y, box_width, box_height);
        }

        ctx.fill();

        ctx.fillStyle = active
            ? INSTRUMENT_LABEL_COLOURS[i]
            : "rgba(255, 255, 255, 0.32)";
        ctx.fillText(label, circle.x, label_y + 1);
    }

    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function draw_square(x, y, width, height, colour = "white")
{
    const radius = Math.min(width, height) * 0.2;

    ctx.fillStyle = colour;
    ctx.beginPath();

    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, radius);
    } else {
        // Fallback for browsers that don't support roundRect yet
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    ctx.fill();
}

function draw_prompt(title, subtitle) {
    const width = Math.min(canvas.width * 0.86, 760);
    const height = 190;
    const x = (canvas.width - width) / 2;
    const y = canvas.height * 0.5 - height / 2;
    const radius = 16;

    ctx.save();
    ctx.fillStyle = "rgba(9, 5, 13, 0.9)";
    ctx.strokeStyle = "rgba(229, 102, 176, 0.4)";
    ctx.lineWidth = 2;

    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, radius);
    } else {
        ctx.rect(x, y, width, height);
    }
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "#BFEAFD";
    ctx.font = "400 42px " + DISPLAY_FONT;
    ctx.shadowColor = "rgba(229, 102, 176, 0.65)";
    ctx.shadowBlur = 20;
    ctx.fillText(title, canvas.width / 2, y + 72);
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "24px " + UI_FONT;
    ctx.fillText(subtitle, canvas.width / 2, y + 134);

    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

var hud_elements = null;
var hud_divider = null;
var hud_divider_width = 0;
var hud_cache = {
    mode: null,
    value: "",
    combo: "",
    blocks: "",
    max: "",
    best: "",
    combo_state: null
};

function get_hud_elements() {
    if (hud_elements) {
        return hud_elements;
    }

    hud_elements = {
        panel: document.getElementById("score-hud"),
        label: document.getElementById("hud-label"),
        value: document.getElementById("hud-value"),
        max: document.getElementById("hud-max"),
        best: document.getElementById("hud-best"),
        combo: document.getElementById("hud-combo"),
        combo_label: document.getElementById("hud-combo-label"),
        blocks: document.getElementById("hud-blocks")
    };

    return hud_elements;
}

function update_score_hud() {
    const els = get_hud_elements();

    if (!els.panel) {
        return;
    }

    const recording = editor_mode;

    if (hud_cache.mode !== recording) {
        hud_cache.mode = recording;
        els.panel.classList.toggle("recording", recording);
        els.label.textContent = recording ? "RECORDING" : "SCORE";
    }

    let value;
    let combo_label;
    let blocks = "";
    let combo_state;

    if (recording) {
        const elapsed = Math.max(0, get_song_time());
        const minutes = Math.floor(elapsed / 60);
        const seconds = Math.floor(elapsed % 60);
        const tenths = Math.floor((elapsed % 1) * 10);

        value = String(minutes).padStart(2, "0") + ":" +
            String(seconds).padStart(2, "0") + "." + tenths;
        combo_label = "notes " + manual_notes.length + "  |  1-4 to record";
        combo_state = false;
    } else {
        value = String(score).padStart(4, "0");
        combo_label = "combo " + String(combo).padStart(3, "0");
        blocks = combo > 0 ? "\u25AE".repeat(Math.min(12, Math.ceil(combo / 10))) : "";
        combo_state = combo > 0;

        const max_text = String(max_combo).padStart(3, "0");

        if (max_text !== hud_cache.max) {
            els.max.textContent = max_text;
            hud_cache.max = max_text;
        }

        const best_text = String(Math.max(best_score, score)).padStart(4, "0");

        if (best_text !== hud_cache.best) {
            els.best.textContent = best_text;
            hud_cache.best = best_text;
        }
    }

    if (value !== hud_cache.value) {
        els.value.textContent = value;
        hud_cache.value = value;
    }

    if (combo_label !== hud_cache.combo) {
        els.combo_label.textContent = combo_label;
        hud_cache.combo = combo_label;
    }

    if (blocks !== hud_cache.blocks) {
        els.blocks.textContent = blocks;
        hud_cache.blocks = blocks;
    }

    if (combo_state !== hud_cache.combo_state) {
        els.combo.classList.toggle("has-combo", combo_state);
        els.combo.classList.toggle("is-zero", !combo_state);
        hud_cache.combo_state = combo_state;
    }
}

function draw_hud() {
    update_score_hud();

    if (!hud_divider || hud_divider_width !== canvas.width) {
        hud_divider = ctx.createLinearGradient(0, 0, canvas.width, 0);
        hud_divider.addColorStop(0, "rgba(229, 102, 176, 0)");
        hud_divider.addColorStop(0.2, "rgba(229, 102, 176, 0.55)");
        hud_divider.addColorStop(0.5, "rgba(129, 240, 255, 0.55)");
        hud_divider.addColorStop(0.8, "rgba(229, 102, 176, 0.55)");
        hud_divider.addColorStop(1, "rgba(229, 102, 176, 0)");
        hud_divider_width = canvas.width;
    }

    ctx.fillStyle = hud_divider;
    ctx.fillRect(0, TITLE_BOUNDARY - 2, canvas.width, 2);
}
function draw_countdown(is_go) {
    const width = Math.min(canvas.width * 0.72, 540);
    const height = 214;
    const x = (canvas.width - width) / 2;
    const y = canvas.height * 0.4 - height / 2;

    ctx.save();
    ctx.fillStyle = "rgba(9, 5, 13, 0.9)";
    ctx.strokeStyle = "rgba(229, 102, 176, 0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();

    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, 14);
    } else {
        ctx.rect(x, y, width, height);
    }

    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.font = "600 17px " + MONO_FONT;
    ctx.fillStyle = "rgba(191, 234, 253, 0.6)";
    ctx.fillText("[durhack@stage ~]$ ./run --song", x + 22, y + 34);

    ctx.textAlign = "center";
    ctx.font = "400 " + (is_go ? 92 : 116) + "px " + DISPLAY_FONT;
    ctx.fillStyle = is_go ? "#CEE765" : "#FAFAFA";
    ctx.shadowColor = is_go ? "rgba(206, 231, 101, 0.75)" : "rgba(229, 102, 176, 0.75)";
    ctx.shadowBlur = 28;
    ctx.fillText(is_go ? "GO" : String(draw_countdown_number()), canvas.width / 2, y + 150);
    ctx.shadowBlur = 0;

    ctx.font = "500 18px " + MONO_FONT;
    ctx.fillStyle = "rgba(229, 102, 176, 0.8)";
    ctx.fillText(is_go ? "[" + "PLAYING" + "]" : "GET READY", canvas.width / 2, y + 188);

    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function draw_countdown_number() {
    const beat = beat_interval > 0 ? beat_interval : 0.5;
    const remaining = -get_song_time();
    return Math.max(1, Math.min(3, Math.ceil(remaining / beat)));
}

// ------------------------------------------------------------------
// Pre-rendered sprites: glossy guitar picks and chunky pixel dinos.
// ------------------------------------------------------------------
const NOTE_SPRITE_SIZE = 256;

function build_note_sprites() {
    note_sprites = [];

    for (let channel = 0; channel < CHANNELS; channel++) {
        note_sprites.push(build_note_sprite(channel));
    }
}

function build_note_sprite(channel) {
    const size = NOTE_SPRITE_SIZE;
    const surface = document.createElement("canvas");
    surface.width = size;
    surface.height = size;

    const g = surface.getContext("2d");
    const colour = CHANNEL_COLOURS[channel];
    const dark = CHANNEL_DARK[channel];
    const light = CHANNEL_LIGHT[channel];
    const cx = size / 2;
    const top = 26;
    const shoulder = 150;
    const bottom = 232;
    const half = 86;

    const pick_path = function () {
        g.beginPath();
        g.moveTo(cx - half + 8, top + 8);
        g.lineTo(cx - half + 16, top);
        g.lineTo(cx + half - 16, top);
        g.lineTo(cx + half - 8, top + 8);
        g.lineTo(cx + half, top + 16);
        g.lineTo(cx + half, shoulder);
        g.lineTo(cx, bottom);
        g.lineTo(cx - half, shoulder);
        g.lineTo(cx - half, top + 16);
        g.closePath();
    };

    // Baked outer glow
    g.save();
    g.shadowColor = colour;
    g.shadowBlur = 30;
    g.fillStyle = colour;
    pick_path();
    g.fill();
    g.restore();

    // Body
    const body = g.createLinearGradient(0, top, 0, bottom);
    body.addColorStop(0, light);
    body.addColorStop(0.35, colour);
    body.addColorStop(1, dark);
    pick_path();
    g.fillStyle = body;
    g.fill();

    // Pixel rim, then a thin dark keyline
    pick_path();
    g.lineWidth = 8;
    g.strokeStyle = "rgba(250, 250, 250, 0.85)";
    g.stroke();

    pick_path();
    g.lineWidth = 3;
    g.strokeStyle = "rgba(13, 7, 16, 0.55)";
    g.stroke();

    // Gloss
    g.save();
    pick_path();
    g.clip();
    const gloss = g.createLinearGradient(cx, top, cx, shoulder);
    gloss.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
    g.fillStyle = gloss;
    g.fillRect(cx - half, top, half * 2, shoulder - top);
    g.restore();

    // Lane glyph
    g.save();
    g.translate(cx, 96);
    g.fillStyle = "rgba(9, 5, 13, 0.72)";
    g.beginPath();

    if (CHANNEL_GLYPHS[channel] === "dot") {
        g.arc(0, 0, 16, 0, Math.PI * 2);
        g.fill();
    } else if (CHANNEL_GLYPHS[channel] === "bar") {
        g.rect(-28, -12, 56, 24);
        g.fill();
    } else if (CHANNEL_GLYPHS[channel] === "diamond") {
        g.moveTo(0, -22);
        g.lineTo(24, 0);
        g.lineTo(0, 22);
        g.lineTo(-24, 0);
        g.closePath();
        g.fill();
    } else {
        g.moveTo(0, -24);
        g.lineTo(24, 18);
        g.lineTo(-24, 18);
        g.closePath();
        g.fill();
    }

    g.restore();
    return surface;
}

function build_dino_sprites() {
    dino_sprites = {
        mint: build_dino_sprite("mint"),
        pink: build_dino_sprite("pink")
    };

    const left = document.getElementById("dino-image-left");
    const right = document.getElementById("dino-image-right");

    if (left) {
        left.src = dino_sprites.mint;
    }

    if (right) {
        right.src = dino_sprites.pink;
    }
}

function build_dino_sprite(variant) {
    const palette = DINO_PALETTES[variant];
    const buffer = build_dino_buffer(variant);
    const scale = 6;
    const surface = document.createElement("canvas");
    surface.width = DINO_WIDTH * scale;
    surface.height = DINO_HEIGHT * scale;

    const g = surface.getContext("2d");

    // Dark outline pass first, so the body pass leaves a clean border.
    g.fillStyle = "rgba(9, 5, 13, 0.95)";

    for (let y = 0; y < DINO_HEIGHT; y++) {
        for (let x = 0; x < DINO_WIDTH; x++) {
            if (buffer[y * DINO_WIDTH + x] === ".") {
                continue;
            }

            g.fillRect(x * scale - 2, y * scale - 2, scale + 4, scale + 4);
        }
    }

    // Body pass
    for (let y = 0; y < DINO_HEIGHT; y++) {
        for (let x = 0; x < DINO_WIDTH; x++) {
            const key = buffer[y * DINO_WIDTH + x];

            if (key === ".") {
                continue;
            }

            g.fillStyle = palette[key] || palette.P;
            g.fillRect(x * scale, y * scale, scale, scale);
        }
    }

    return surface.toDataURL("image/png");
}

function build_dino_buffer(variant) {
    const buffer = new Array(DINO_WIDTH * DINO_HEIGHT).fill(".");

    const set_pixel = function (x, y, key) {
        if (x >= 0 && x < DINO_WIDTH && y >= 0 && y < DINO_HEIGHT) {
            buffer[y * DINO_WIDTH + x] = key;
        }
    };

    const rect = function (x, y, w, h, key) {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) {
                set_pixel(xx, yy, key);
            }
        }
    };

    const ellipse = function (cx, cy, rx, ry, key) {
        for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
            for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
                const dx = (xx + 0.5 - cx) / rx;
                const dy = (yy + 0.5 - cy) / ry;

                if (dx * dx + dy * dy <= 1) {
                    set_pixel(xx, yy, key);
                }
            }
        }
    };

    // Tail (behind the body)
    ellipse(6, 30, 6, 4, "d");
    ellipse(6, 29.5, 5.4, 3.4, "P");
    ellipse(3.8, 28.5, 2.2, 1.4, "L");

    // Body and arms
    ellipse(19, 30, 9.5, 8, "d");
    ellipse(18.5, 29, 9.5, 8, "P");

    ellipse(8, 25, 3.4, 5.4, "d");
    ellipse(8, 24.5, 3.1, 5, "P");
    ellipse(27, 25, 3.4, 5.4, "d");
    ellipse(27, 24.5, 3.1, 5, "P");
    ellipse(7.5, 22.5, 1.6, 1.8, "L");
    ellipse(27.5, 22.5, 1.6, 1.8, "L");

    // Legs and feet
    rect(12, 32, 4, 6, "d");
    rect(20, 32, 4, 6, "d");
    rect(12, 32, 4, 4, "P");
    rect(20, 32, 4, 4, "P");

    ellipse(13.5, 37.5, 3.8, 2.1, "d");
    ellipse(22.5, 37.5, 3.8, 2.1, "d");
    ellipse(13.5, 37, 3.6, 1.9, "P");
    ellipse(22.5, 37, 3.6, 1.9, "P");
    rect(10, 37, 2, 1, "W");
    rect(24, 37, 2, 1, "W");

    // Shirt
    ellipse(18, 27, 6.5, 5.5, "W");
    rect(15, 21, 2, 2, "W");
    rect(19, 21, 2, 2, "W");

    // Head: shadow first, then the fluff and face
    ellipse(19, 15, 11.5, 10.5, "d");
    ellipse(18, 14, 11.5, 10.5, "P");

    const fluff = [
        [9, 6], [12, 3.5], [15.5, 2.5], [19, 2.5], [22.5, 3.5], [26, 6],
        [28, 10], [29, 14], [28, 18], [7, 10], [6, 14], [7, 18]
    ];

    for (const point of fluff) {
        ellipse(point[0], point[1], 2, 2, "P");
    }

    ellipse(11, 5, 1.8, 1.5, "L");
    ellipse(15, 3.8, 1.8, 1.4, "L");
    ellipse(19.5, 3.6, 1.8, 1.4, "L");
    ellipse(7.5, 11, 1.3, 1.3, "L");

    // Little crest, like the official plush's tuft
    rect(17, 0, 2, 2, "L");
    rect(16, 0, 1, 1, "L");
    rect(20, 1, 1, 1, "L");

    // Muzzle and open mouth
    ellipse(18, 18, 7.5, 5.5, "d");
    ellipse(18, 17.5, 7.4, 5.4, "W");
    ellipse(18, 18.5, 5.5, 3.2, "M");
    ellipse(18, 20, 3, 1.2, "T");
    rect(14, 16, 2, 1, "W");
    rect(21, 16, 2, 1, "W");

    // Eyes with a small glint
    rect(12, 9, 2, 3, "K");
    rect(22, 9, 2, 3, "K");
    rect(12, 9, 1, 1, "W");
    rect(22, 9, 1, 1, "W");

    // Cheeks
    rect(9, 16, 2, 2, "L");
    rect(25, 16, 2, 2, "L");

    // Bowtie over the chin, plus shirt buttons
    rect(11, 23, 5, 3, "K");
    rect(20, 23, 5, 3, "K");
    rect(15, 23, 6, 4, "K");
    rect(17, 24, 2, 1, "A");
    rect(17, 29, 1, 1, "K");
    rect(17, 31, 1, 1, "K");

    if (variant === "mint") {
        // Headphones over the fluff
        rect(9, 2, 18, 2, "A");
        rect(7, 4, 2, 4, "A");
        rect(27, 4, 2, 4, "A");
        rect(4, 9, 4, 7, "A");
        rect(28, 9, 4, 7, "A");
        rect(5, 11, 2, 3, "K");
        rect(29, 11, 2, 3, "K");
        rect(5, 10, 1, 1, "L");
        rect(29, 10, 1, 1, "L");
    }

    return buffer;
}

// ------------------------------------------------------------------
// Combo milestones, dino celebrations and effects toggle.
// ------------------------------------------------------------------
function load_best_score() {
    try {
        best_score = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
    } catch (error) {
        best_score = 0;
    }
}

function persist_best_score() {
    if (score <= best_score) {
        return;
    }

    best_score = score;

    try {
        localStorage.setItem(BEST_SCORE_KEY, String(best_score));
    } catch (error) {
        // Storage can be unavailable in private windows
    }
}

function init_effects_setting() {
    let stored = null;

    try {
        stored = localStorage.getItem(FX_STORAGE_KEY);
    } catch (error) {
        stored = null;
    }

    if (stored === "on" || stored === "off") {
        effects_enabled = stored === "on";
    } else {
        effects_enabled = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    apply_fx_button();
}

function apply_fx_button() {
    const button = document.getElementById("fx-toggle");

    if (!button) {
        return;
    }

    button.textContent = effects_enabled ? "FX ON" : "FX OFF";
    button.classList.toggle("fx-off", !effects_enabled);
    button.setAttribute("aria-pressed", effects_enabled ? "true" : "false");
    button.title = effects_enabled
        ? "Celebration effects on - click to disable"
        : "Celebration effects off - click to enable";
}

function toggle_effects() {
    effects_enabled = !effects_enabled;

    try {
        localStorage.setItem(FX_STORAGE_KEY, effects_enabled ? "on" : "off");
    } catch (error) {
        // Storage can be unavailable in private windows
    }

    apply_fx_button();

    if (!effects_enabled) {
        hide_celebrations();
    }
}

function hide_celebrations() {
    for (const side of ["left", "right"]) {
        const actor = document.getElementById("dino-actor-" + side);

        if (actor) {
            actor.classList.remove("show", "hop");
        }

        clearTimeout(dino_hide_timers[side]);
    }

    const layer = document.getElementById("confetti-layer");

    if (layer) {
        layer.textContent = "";
    }

    const glow = document.getElementById("fx-glow");

    if (glow) {
        glow.classList.remove("active");
    }
}

function set_playing_state(playing) {
    document.body.classList.toggle("is-playing", playing);
}

function check_milestone() {
    if (!effects_enabled) {
        return;
    }

    for (let i = 0; i < MILESTONES.length; i++) {
        if (MILESTONES[i].at === combo) {
            celebrate_milestone(MILESTONES[i]);
            return;
        }
    }

    if (combo > 100 && combo % 100 === 0) {
        celebrate_milestone({
            at: combo,
            side: (combo / 100) % 2 === 0 ? "left" : "right",
            text: MILESTONE_JOKES[((combo / 100) - 1) % MILESTONE_JOKES.length],
            sound: "arp",
            glow: true
        });
    }
}

function celebrate_milestone(milestone) {
    last_milestone = milestone.at;
    last_celebration_at = performance.now();

    if (milestone.sound) {
        play_milestone_sound(milestone.sound);
    }

    if (milestone.glow) {
        trigger_edge_glow(milestone.at >= 100 ? "#FBFF00" : "#81F0FF");
    }

    if (milestone.side === "both") {
        show_dino("left", "PRODUCTION", { duration: 3200 });
        show_dino("right", "READY", { duration: 3200 });
        spawn_keycap_confetti("left");
        spawn_keycap_confetti("right");
    } else {
        show_dino(milestone.side, milestone.text, {
            hop: milestone.hop,
            duration: 2600
        });

        if (milestone.confetti) {
            spawn_keycap_confetti(milestone.side);
        }
    }
}

function show_dino(side, text, options = {}) {
    if (!effects_enabled) {
        return;
    }

    const overlay = document.getElementById("dino-overlay");
    const actor = document.getElementById("dino-actor-" + side);
    const label = document.getElementById("dino-text-" + side);

    if (!overlay || !actor || !label) {
        return;
    }

    overlay.hidden = false;
    label.textContent = text;
    actor.classList.remove("show", "hop");

    // Force a reflow so the pop-in transition replays on quick combos.
    void actor.offsetWidth;
    actor.classList.add("show");

    if (options.hop) {
        actor.classList.add("hop");
    }

    clearTimeout(dino_hide_timers[side]);
    dino_hide_timers[side] = setTimeout(function () {
        actor.classList.remove("show", "hop");
    }, options.duration || 2500);
}

function trigger_edge_glow(colour) {
    const glow = document.getElementById("fx-glow");

    if (!glow || !effects_enabled) {
        return;
    }

    glow.style.setProperty("--glow", colour);
    glow.classList.remove("active");
    void glow.offsetWidth;
    glow.classList.add("active");
}

function spawn_keycap_confetti(side) {
    if (!effects_enabled) {
        return;
    }

    const layer = document.getElementById("confetti-layer");

    if (!layer) {
        return;
    }

    const glyphs = [";", "{", "}", "</>", "0", "1", "=>", "git"];
    const from_left = side === "left";
    const landscape_mode = document.body.classList.contains("landscape");

    for (let i = 0; i < 14; i++) {
        const keycap = document.createElement("span");
        keycap.className = "keycap";
        keycap.textContent = glyphs[i % glyphs.length];
        keycap.style.left = (landscape_mode || !from_left
            ? 74 + Math.random() * 22
            : 2 + Math.random() * 22) + "vw";
        keycap.style.animationDelay = (Math.random() * 0.3) + "s";
        keycap.style.setProperty("--drift", (Math.random() * 140 - 70) + "px");
        keycap.style.setProperty("--spin", (Math.random() * 360 - 180) + "deg");
        layer.appendChild(keycap);

        setTimeout(function () {
            keycap.remove();
        }, 1900);
    }
}

function play_milestone_sound(kind) {
    if (!SOUND_ENABLED || !effects_enabled) {
        return;
    }

    const audio = get_audio_context();

    if (!audio) {
        return;
    }

    const now = audio.currentTime + 0.01;
    const destination = get_audio_destination(audio);

    const blip = function (frequency, start, duration, type, volume) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();

        oscillator.type = type || "square";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume || 0.015, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);

        return oscillator;
    };

    if (kind === "horn") {
        const horn = blip(196, now, 0.42, "sawtooth", 0.02);
        horn.frequency.exponentialRampToValueAtTime(392, now + 0.16);
        horn.frequency.exponentialRampToValueAtTime(330, now + 0.38);
        blip(198, now, 0.42, "sawtooth", 0.011);
        return;
    }

    if (kind === "arp") {
        [659.25, 830.61, 987.77].forEach(function (frequency, index) {
            blip(frequency, now + index * 0.085, 0.09, "square", 0.016);
        });
        return;
    }

    blip(1046.5, now, 0.08, "square", 0.014);
}

function break_combo(message) {
    attempt_broken = true;

    const previous = combo;
    combo = 0;
    last_milestone = 0;

    if (!effects_enabled || previous < 10 || editor_mode) {
        return;
    }

    // Don't stomp on a milestone that is still on screen.
    if (performance.now() - last_celebration_at < 2200) {
        return;
    }

    const now = get_song_time();

    if (now - last_miss_shown_at < 1.2) {
        return;
    }

    last_miss_shown_at = now;

    // Duck the dino in from the side opposite where it last appeared.
    const side = previous % 20 === 0 ? "right" : "left";
    const text = message || MISS_MESSAGES[previous % MISS_MESSAGES.length];

    show_dino(side, text, { duration: 1500 });
}

// Called when the audio ends naturally. A run with no misses or bad presses
// gets the full-combo "DEPLOYED" celebration regardless of the FX setting,
// because the banner also reports it on the canvas.
function finish_song() {
    const total_notes = selected_beats.length;
    const full_combo = !editor_mode && !attempt_broken && score > 0 &&
        total_notes > 0 && score >= total_notes;
    const new_best = score > best_score;

    song_started = false;
    song_starting = false;
    persist_best_score();
    set_playing_state(false);
    hide_celebrations();

    combo = 0;
    max_combo = 0;
    last_milestone = 0;
    active_notes.length = 0;
    clear_effects();
    update_editor_controls();

    finish_banner = editor_mode ? null : {
        full_combo: full_combo,
        new_best: new_best,
        until: performance.now() + 6500
    };

    if (full_combo) {
        show_dino("left", "DEPLOYED", { duration: 4200 });
        show_dino("right", "TO PROD", { duration: 4200 });
        trigger_edge_glow("#CEE765");
        spawn_keycap_confetti("left");
        spawn_keycap_confetti("right");
        play_milestone_sound("horn");
    } else if (new_best && !editor_mode) {
        show_dino("left", "PASSED CI", { duration: 3000 });
        trigger_edge_glow("#81F0FF");
        play_milestone_sound("arp");
    }
}

function gameLoop() {
    const delta_time = get_delta_time();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw_hud();

    if (DEBUG_INPUT_ENABLED) {
        ctx.font = "24px Arial";
        ctx.textAlign = "left";
        ctx.fillText(
            "sync " + Math.round(sync_offset * 1000) + "ms  ([ / ])" +
            "  sensors " + (window.SENSOR_STATUS || "connecting"),
            20,
            canvas.height - 24
        );
    }

    for (let i = 0; i < CHANNELS; i++) {
        circle_flash_timers[i] = Math.max(0, circle_flash_timers[i] - delta_time);
        circle_hit_timers[i] = Math.max(0, circle_hit_timers[i] - delta_time);
    }

    if (is_portrait()) {
        // Vertical lanes converging toward a vanishing point at the top
        const base_lane = canvas.width / CHANNELS;
        const near_y = get_circle_center(0).y;
        const extend_t = (canvas.height - TITLE_BOUNDARY) / (near_y - TITLE_BOUNDARY);

        // Fade the outer lines out with the guitar mask
        const line_fade = ctx.createLinearGradient(0, TITLE_BOUNDARY, 0, canvas.height);
        line_fade.addColorStop(0, "rgba(191, 234, 253, 0.55)");
        line_fade.addColorStop(0.80, "rgba(191, 234, 253, 0.5)");
        line_fade.addColorStop(0.92, "rgba(191, 234, 253, 0)");

        ctx.strokeStyle = line_fade;
        ctx.lineWidth = 4;

        // Only the outer boundaries are drawn; the inner lane separators are hidden
        for (let i of [0, CHANNELS]) {
            const near_x = canvas.width / 2 + (base_lane * i - canvas.width / 2) * LANE_WIDTH_SCALE;
            const far_x = canvas.width / 2 + (near_x - canvas.width / 2) * FAR_SCALE;
            const ext_x = far_x + (near_x - far_x) * extend_t;

            ctx.beginPath();
            ctx.moveTo(far_x, TITLE_BOUNDARY);
            ctx.lineTo(ext_x, canvas.height);
            ctx.stroke();
        }

        for (let i = 0; i < CHANNELS; i++) {
            const circle = get_circle_center(i);
            const flash = circle_flash_timers[i] / CIRCLE_FLASH_DURATION;
            const fill_colour = flash > 0 ? CHANNEL_COLOURS[i] : null;
            draw_circle(circle.x, circle.y, get_circle_radius(), fill_colour, flash, i);
        }
    } else {
        // Horizontal lanes converging toward a vanishing point on the right
        const base_lane = get_lane_height();
        const near_x = get_circle_center(0).x;
        const extend_t = canvas.width / (canvas.width - near_x);

        // Let the outer lines fade out toward the body instead of clipping
        const line_fade = ctx.createLinearGradient(canvas.width, 0, 0, 0);
        line_fade.addColorStop(0, "rgba(191, 234, 253, 0.55)");
        line_fade.addColorStop(0.92, "rgba(191, 234, 253, 0.5)");
        line_fade.addColorStop(1, "rgba(191, 234, 253, 0)");

        ctx.strokeStyle = line_fade;
        ctx.lineWidth = 4;

        // Only the outer boundaries are drawn; the inner lane separators are hidden
        for (let i of [0, CHANNELS]) {
            const base_y = TITLE_BOUNDARY + base_lane * i;
            const near_y = canvas.height / 2 + (base_y - canvas.height / 2) * LANE_WIDTH_SCALE;
            const far_y = canvas.height / 2 + (near_y - canvas.height / 2) * FAR_SCALE;
            const ext_y = far_y + (near_y - far_y) * extend_t;

            ctx.beginPath();
            ctx.moveTo(canvas.width, far_y);
            ctx.lineTo(0, ext_y);
            ctx.stroke();
        }

        for (let i = 0; i < CHANNELS; i++) {
            const circle = get_circle_center(i);
            const flash = circle_flash_timers[i] / CIRCLE_FLASH_DURATION;
            const fill_colour = flash > 0 ? CHANNEL_COLOURS[i] : null;
            draw_circle(circle.x, circle.y, get_circle_radius(), fill_colour, flash, i);
        }
    }

    draw_instrument_labels();

    // Update and draw every note each frame, before spawning new ones
    for (let note of active_notes) {
        note.update(delta_time);
        note.draw();
    }

    update_and_draw_effects(delta_time);

    // A note that slips past the hit window breaks the combo.
    const song_time = get_song_time();

    if (song_started && !editor_mode) {
        for (let i = active_notes.length - 1; i >= 0; i--) {
            const note = active_notes[i];

            if (note.hit_time === null) {
                continue;
            }

            if (song_time - note.hit_time > HIT_WINDOW) {
                active_notes.splice(i, 1);
                break_combo();
            }
        }
    }

    // Drop notes once they have passed well beyond the hit circles
    active_notes = active_notes.filter(note => note.t < 1.3);

    if (song_started && beats_loaded) {
        if (selected_beats.length > 0) {
            spawn_beat_notes();
        } else {
            // Analysis found nothing usable; keep the game playable
            spawn_timer += delta_time;
            if (spawn_timer >= spawn_interval) {
                spawn_timer -= spawn_interval;
                poll_input_and_note();
            }
        }
    }

    const prompt_time = get_song_time();

    if (song_loading) {
        draw_prompt("ANALYSING SONG...", "Preparing the note chart");
    } else if (!song_buffer && pending_note_map) {
        draw_prompt("NOTE MAP READY", "Load the matching audio file to use it");
    } else if (!song_buffer) {
        draw_prompt("NO SONG LOADED", "Use \u201cLoad song\u201d to choose an audio file and optional note map");
    } else if (editor_mode && song_started && prompt_time < 0) {
        draw_prompt("RECORDING", "Press 1-4 to drop notes");
    } else if (!editor_mode && song_started && prompt_time < -0.02) {
        draw_countdown(false);
    } else if (!editor_mode && song_started && prompt_time < 0.5) {
        draw_countdown(true);
    } else if (editor_mode && !song_started) {
        draw_prompt("MANUAL MAP", "Use Replay to restart the song");
    } else if (!song_started && finish_banner && performance.now() < finish_banner.until) {
        if (finish_banner.full_combo) {
            draw_prompt("FULL COMBO", "DEPLOYED TO PROD \u2014 no missed notes");
        } else if (finish_banner.new_best) {
            draw_prompt("NEW BEST", "Score " + score);
        } else {
            draw_prompt("TRACK COMPLETE", "Score " + score);
        }
    } else if (!song_started) {
        draw_prompt("PRESS ANY KEY OR SENSOR", "Song ready");
    }

    tick++;
    requestAnimationFrame(gameLoop);
}

function poll_input_and_note() {
    // Fallback note generation when beat analysis is unavailable
    let note = new Note(Math.floor(Math.random() * CHANNELS), NOTE_SPEED);
    active_notes.push(note);
}

// Rudimentary beat detection: onset envelope -> peaks -> median interval ->
// phase search over a fixed beat grid.
function compute_onset_energy(samples, sample_rate) {
    const frame_size = 1024;
    const hop = 256;
    const frame_count = Math.floor((samples.length - frame_size) / hop);
    const energy = new Float32Array(Math.max(0, frame_count));

    let previous_rms = 0;
    for (let i = 0; i < frame_count; i++) {
        const start = i * hop;
        let sum = 0;

        for (let j = 0; j < frame_size; j++) {
            const sample = samples[start + j];
            sum += sample * sample;
        }

        const rms = Math.sqrt(sum / frame_size);
        energy[i] = Math.max(0, rms - previous_rms);
        previous_rms = rms;
    }

    return { energy: energy, frames_per_second: sample_rate / hop };
}

function detect_beats_from_energy(energy, frames_per_second, duration) {
    const frame_count = energy.length;

    let max_energy = 0;
    for (let i = 0; i < frame_count; i++) {
        max_energy = Math.max(max_energy, energy[i]);
    }

    if (max_energy <= 0) {
        return { beats: [], interval: 0.5, offset: 0 };
    }

    const threshold = max_energy * 0.25;
    const min_gap_frames = Math.floor(frames_per_second * 0.1);
    const peaks = [];
    let last_peak = -min_gap_frames;

    for (let i = 1; i < frame_count - 1; i++) {
        if (energy[i] > threshold && energy[i] >= energy[i - 1] && energy[i] >= energy[i + 1]) {
            if (i - last_peak >= min_gap_frames) {
                peaks.push({
                    time: i / frames_per_second,
                    strength: energy[i]
                });
                last_peak = i;
            }
        }
    }

    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
        const delta = peaks[i].time - peaks[i - 1].time;
        if (delta >= 0.25 && delta <= 1.2) {
            intervals.push(delta);
        }
    }

    intervals.sort((a, b) => a - b);
    let interval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0.5;

    // Fold into a plausible beat range
    while (interval < 0.35) interval *= 2;
    while (interval > 0.9) interval /= 2;

    // Refine tempo and phase by finding the grid that lands on the most
    // onset energy. This corrects small median/tempo errors that otherwise
    // drift out of sync over a long track.
    const grid = refine_beat_grid(energy, frames_per_second, duration, interval);
    interval = grid.interval;

    const beats = [];
    for (let t = grid.offset; t < duration; t += interval) {
        const index = Math.round(t * frames_per_second);
        let strength = 0;

        for (let k = -2; k <= 2; k++) {
            const j = index + k;
            if (j >= 0 && j < energy.length) {
                strength = Math.max(strength, energy[j]);
            }
        }

        beats.push({ time: t, strength: strength });
    }

    return { beats: beats, interval: interval, offset: grid.offset };
}

function detect_beat_times(buffer) {
    const mono = buffer.getChannelData(0);
    const onset = compute_onset_energy(mono, buffer.sampleRate);

    return detect_beats_from_energy(onset.energy, onset.frames_per_second, buffer.duration);
}

function refine_beat_grid(energy, frames_per_second, duration, rough_interval) {
    function score(interval, offset) {
        let total = 0;
        let count = 0;

        for (let t = offset; t < duration; t += interval) {
            const index = Math.round(t * frames_per_second);
            if (index >= 1 && index < energy.length - 1) {
                total += energy[index] + 0.5 * energy[index - 1] + 0.5 * energy[index + 1];
                count++;
            }
        }

        return count > 0 ? total / count : 0;
    }

    let best = { score: -1, interval: rough_interval, offset: 0 };

    function scan(interval_min, interval_max, interval_step, offset_step) {
        for (let candidate = interval_min; candidate <= interval_max; candidate += interval_step) {
            for (let offset = 0; offset < candidate; offset += offset_step) {
                const candidate_score = score(candidate, offset);
                if (candidate_score > best.score) {
                    best = { score: candidate_score, interval: candidate, offset: offset };
                }
            }
        }
    }

    // Coarse search around the rough estimate, then a fine pass
    scan(rough_interval * 0.96, rough_interval * 1.04, 0.002, 0.01);

    const coarse_interval = best.interval;
    scan(coarse_interval - 0.004, coarse_interval + 0.004, 0.0002, 0.004);

    return best;
}

// Keep beats that carry real energy and respect the polling boundary.
// Grid beats are used so notes land on the musical cycle, not on the
// leading edge of a detected transient.
function select_beats(beats) {
    let max_strength = 0;
    for (let i = 0; i < beats.length; i++) {
        max_strength = Math.max(max_strength, beats[i].strength);
    }

    const threshold = max_strength * 0.03;
    const selected = [];
    let last = -Infinity;

    if (max_strength <= 0) {
        return selected;
    }

    for (const beat of beats) {
        if (beat.strength < threshold) {
            continue;
        }

        if (beat.time - last < spawn_interval - 1e-6) {
            continue;
        }

        selected.push(beat.time);
        last = beat.time;
    }

    return selected;
}

function build_bpm_map(buffer) {
    spawn_interval = MIN_NOTE_GAP;

    const analysis = detect_beat_times(buffer);
    const times = select_beats(analysis.beats);
    const events = [];

    for (let i = 0; i < times.length; i++) {
        events.push({
            time: times[i],
            channel: Math.floor(Math.random() * CHANNELS)
        });
    }

    return { events: events, interval: analysis.interval, stems: false };
}

async function load_demucs_session(on_status) {
    if (demucs_unavailable) {
        throw new Error("Demucs model unavailable");
    }

    if (demucs_session) {
        return demucs_session;
    }

    on_status("Checking Demucs model...");

    const head = await fetch(DEMUCS_MODEL_URL, { method: "HEAD" });
    if (!head.ok) {
        demucs_unavailable = true;
        throw new Error("Demucs model not found at " + DEMUCS_MODEL_URL);
    }

    on_status("Loading onnxruntime-web...");

    try {
        demucs_ort = await import(DEMUCS_ORT_URL);
    } catch (error) {
        demucs_unavailable = true;
        throw error;
    }

    // Multi-threaded WASM needs SharedArrayBuffer, which browsers only expose
    // on cross-origin-isolated pages. Fall back to one thread otherwise.
    const can_use_threads = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
    demucs_ort.env.wasm.numThreads = can_use_threads
        ? Math.min(navigator.hardwareConcurrency || 4, 6)
        : 1;
    demucs_ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

    // Run the model in ORT's proxy worker. The main thread stays responsive
    // between chunks, which stops Firefox's "slow script" warning.
    demucs_ort.env.wasm.proxy = true;

    on_status("Loading Demucs model (first load can take a while)...");

    const session_options = {
        graphOptimizationLevel: "all",
        enableCpuMemArena: false,
        enableMemPattern: false,
        extra: {
            // ORT tries to constant-fold the inverse STFT scatter into a
            // multi-gigabyte constant. Disable just that pass; everything
            // else still runs at full optimisation.
            optimization: {
                disable_specified_optimizers: "ConstantFolding"
            }
        }
    };

    try {
        demucs_session = await demucs_ort.InferenceSession.create(DEMUCS_MODEL_URL, {
            ...session_options,
            executionProviders: ["wasm"]
        });
    } catch (error) {
        console.warn("Worker inference failed; retrying on the main thread.", error);
        demucs_ort.env.wasm.proxy = false;
        demucs_session = await demucs_ort.InferenceSession.create(DEMUCS_MODEL_URL, {
            ...session_options,
            executionProviders: ["wasm"]
        });
    }

    return demucs_session;
}

async function release_demucs_session() {
    if (!demucs_session) {
        return;
    }

    const session = demucs_session;
    demucs_session = null;

    try {
        if (typeof session.release === "function") {
            await session.release();
        }
    } catch (error) {
        console.warn("Could not release the Demucs session.", error);
    }
}

function fill_chunk_channel(chunk, offset, source, source_rate, start, length) {
    if (source_rate === DEMUCS_SAMPLE_RATE) {
        const available = Math.max(0, Math.min(length, source.length - start));

        if (available > 0) {
            chunk.set(source.subarray(start, start + available), offset);
        }

        return;
    }

    // Resample directly into the chunk so a long song never needs a second
    // full-length copy of both channels.
    const ratio = source_rate / DEMUCS_SAMPLE_RATE;
    const source_length = source.length;

    for (let i = 0; i < length; i++) {
        const position = (start + i) * ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = source[Math.min(index, source_length - 1)] || 0;
        const b = source[Math.min(index + 1, source_length - 1)] || 0;

        chunk[offset + i] = a + (b - a) * fraction;
    }
}

async function separate_stem_envelopes(buffer, on_status) {
    const session = await load_demucs_session(on_status);

    const source_left = buffer.getChannelData(0);
    const source_right = buffer.numberOfChannels > 1
        ? buffer.getChannelData(1)
        : source_left;
    const source_rate = buffer.sampleRate;
    const total_length = Math.max(1, Math.round(buffer.duration * DEMUCS_SAMPLE_RATE));

    const segment_length = Math.round(DEMUCS_SEGMENT_SECONDS * DEMUCS_SAMPLE_RATE);
    // 10% overlap keeps enough context at chunk boundaries while cutting
    // roughly 17% of the model calls compared with the old 25% overlap.
    const overlap = Math.floor(segment_length / 10);
    const stride = segment_length - overlap;

    const frame_size = 1024;
    const hop = 256;
    const frames_per_second = DEMUCS_SAMPLE_RATE / hop;
    const frame_count = Math.ceil(total_length / hop) + 1;
    const lowpass_alpha = 1 - Math.exp(-2 * Math.PI * 250 / DEMUCS_SAMPLE_RATE);

    let envelopes = null;
    let previous = null;
    let low_state = null;
    let band_energy = null;
    let stem_count = 0;

    const chunk = new Float32Array(2 * segment_length);
    const chunk_count = Math.max(1, Math.ceil(total_length / stride));
    const input_name = session.inputNames ? session.inputNames[0] : "mix";
    const output_name = session.outputNames ? session.outputNames[0] : "stems";
    const separation_started = performance.now();

    for (let c = 0; c < chunk_count; c++) {
        const start = c * stride;
        const end = Math.min(start + segment_length, total_length);
        const chunk_length = end - start;

        chunk.fill(0);
        fill_chunk_channel(chunk, 0, source_left, source_rate, start, chunk_length);
        fill_chunk_channel(chunk, segment_length, source_right, source_rate, start, chunk_length);

        const percent = Math.floor((c / chunk_count) * 100);
        let eta = "estimating...";

        if (c > 0) {
            const elapsed = (performance.now() - separation_started) / 1000;
            const seconds_left = Math.max(0, (elapsed / c) * (chunk_count - c));

            eta = seconds_left >= 60
                ? "~" + Math.ceil(seconds_left / 60) + " min left"
                : "~" + Math.ceil(seconds_left) + "s left";
        }

        on_status("Separating stems: " + (c + 1) + "/" + chunk_count +
            " (" + percent + "%) \u2014 " + eta);

        // The proxy worker transfers the input buffer to its thread, which
        // detaches it. Pass a copy so the reusable chunk stays valid.
        const input_data = demucs_ort.env.wasm.proxy ? chunk.slice() : chunk;
        const input = new demucs_ort.Tensor(
            "float32",
            input_data,
            [1, 2, segment_length]
        );

        const feeds = {};
        feeds[input_name] = input;
        let output = null;

        try {
            const result = await session.run(feeds);
            output = result[output_name];
            const stems = output.data;

            if (envelopes === null) {
                const dims = output.dims || [];
                stem_count = dims.length >= 4 ? dims[1] : 4;

                envelopes = {
                    full: [],
                    low: [],
                    high: []
                };

                for (let s = 0; s < stem_count; s++) {
                    envelopes.full.push(new Float32Array(frame_count));
                    envelopes.low.push(new Float32Array(frame_count));
                    envelopes.high.push(new Float32Array(frame_count));
                }

                previous = {
                    full: new Float32Array(stem_count),
                    low: new Float32Array(stem_count),
                    high: new Float32Array(stem_count)
                };
                low_state = new Float32Array(stem_count);
                band_energy = {
                    low: new Float64Array(stem_count),
                    high: new Float64Array(stem_count)
                };
            }

            const first_frame = Math.max(1, Math.ceil(start / hop));
            const last_frame = c === chunk_count - 1
                ? frame_count
                : Math.min(frame_count, Math.ceil((start + stride) / hop));

            for (let f = first_frame; f < last_frame; f++) {
                const local = f * hop - start;
                if (local < 0 || local + frame_size > segment_length) {
                    continue;
                }

                for (let s = 0; s < stem_count; s++) {
                    const base = s * 2 * segment_length;
                    let low_sum = 0;
                    let high_sum = 0;
                    let full_sum = 0;
                    let state = low_state[s];

                    for (let j = 0; j < frame_size; j++) {
                        const l = stems[base + local + j];
                        const r = stems[base + segment_length + local + j];
                        const value = (l + r) * 0.5;

                        // One-pole split at ~250 Hz. Low frequencies are
                        // where bass/drum bleed lives; guitar, piano and
                        // vocals keep most of their energy above it.
                        state += lowpass_alpha * (value - state);
                        const high = value - state;

                        low_sum += state * state;
                        high_sum += high * high;
                        full_sum += value * value;
                    }

                    low_state[s] = state;
                    band_energy.low[s] += low_sum;
                    band_energy.high[s] += high_sum;

                    const low_rms = Math.sqrt(low_sum / frame_size);
                    const high_rms = Math.sqrt(high_sum / frame_size);
                    const full_rms = Math.sqrt(full_sum / frame_size);

                    const low_onset = Math.max(0, low_rms - previous.low[s]);
                    const high_onset = Math.max(0, high_rms - previous.high[s]);
                    const full_onset = Math.max(0, full_rms - previous.full[s]);

                    previous.low[s] = low_rms;
                    previous.high[s] = high_rms;
                    previous.full[s] = full_rms;

                    if (low_onset > envelopes.low[s][f]) {
                        envelopes.low[s][f] = low_onset;
                    }

                    if (high_onset > envelopes.high[s][f]) {
                        envelopes.high[s][f] = high_onset;
                    }

                    if (full_onset > envelopes.full[s][f]) {
                        envelopes.full[s][f] = full_onset;
                    }
                }
            }
        } finally {
            // ORT output tensors are WASM-backed. Explicit disposal stops a
            // long song's per-chunk buffers from piling up between runs.
            if (output && typeof output.dispose === "function") {
                output.dispose();
            }

            if (typeof input.dispose === "function") {
                input.dispose();
            }
        }

        // Let the UI paint between inference chunks
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
        envelopes: envelopes,
        band_energy: band_energy,
        stem_count: stem_count,
        frames_per_second: frames_per_second,
        duration: total_length / DEMUCS_SAMPLE_RATE
    };
}

function percentile_of_energy(values, fraction) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = values.slice().sort();
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
    return sorted[index];
}

// Turn a stem's onset envelope into note times. Uses an adaptive local
// threshold so quiet passages still produce notes without amplifying bleed
// from the other stems.
function detect_onsets_from_energy(energy, frames_per_second) {
    const frame_count = energy.length;
    const level = percentile_of_energy(energy, 0.99);

    if (frame_count < 5 || level <= 1e-6) {
        return { onsets: [], level: level };
    }

    const floor = level * DEMUCS_ONSET_FLOOR;
    const half_window = Math.max(2, Math.round(frames_per_second * 0.5));
    const min_gap_frames = Math.max(1, Math.round(frames_per_second * DEMUCS_RAW_MIN_GAP));

    // Prefix sums give a cheap local average for adaptive peak picking.
    const prefix = new Float64Array(frame_count + 1);
    for (let i = 0; i < frame_count; i++) {
        prefix[i + 1] = prefix[i] + energy[i];
    }

    const onsets = [];
    let last_peak = -min_gap_frames;

    for (let i = 2; i < frame_count - 2; i++) {
        const value = energy[i];

        if (value < floor ||
            value < energy[i - 1] || value < energy[i + 1] ||
            value < energy[i - 2] || value < energy[i + 2]) {
            continue;
        }

        const from = Math.max(0, i - half_window);
        const to = Math.min(frame_count, i + half_window + 1);
        const local_mean = (prefix[to] - prefix[from]) / (to - from);

        if (value < local_mean * DEMUCS_ONSET_FACTOR) {
            continue;
        }

        if (i - last_peak < min_gap_frames) {
            continue;
        }

        onsets.push(i / frames_per_second);
        last_peak = i;
    }

    return { onsets: onsets, level: level };
}

function thin_onsets(onsets, min_gap) {
    const selected = [];
    let last = -Infinity;

    for (let i = 0; i < onsets.length; i++) {
        const time = onsets[i];

        if (time - last < min_gap) {
            continue;
        }

        selected.push(time);
        last = time;
    }

    return selected;
}

// Times are sorted, so use a binary search instead of a full scan.
function is_near_sorted(time, sorted_times, window) {
    let low = 0;
    let high = sorted_times.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = sorted_times[middle];

        if (Math.abs(candidate - time) <= window) {
            return true;
        }

        if (candidate < time) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return false;
}

// Optional fallback used only when FALLBACK_MISSING_INSTRUMENTS is enabled.
// Pitched channels never borrow from drums. Piano prefers the "other" stem
// which is where keys and strings normally end up.
function choose_fallback_source(analyses, instrument, silent_threshold) {
    const exclude_drums = instrument.channel !== 0;
    let best = null;
    let preferred = null;

    for (let i = 0; i < analyses.length; i++) {
        const analysis = analyses[i];

        if (analysis.onsets.length === 0 || analysis.level < silent_threshold) {
            continue;
        }

        if (exclude_drums && analysis.name === "drums") {
            continue;
        }

        if (!best || analysis.level > best.level) {
            best = analysis;
        }

        if (instrument.prefer && analysis.name === instrument.prefer) {
            preferred = analysis;
        }
    }

    if (preferred && best && preferred.level >= best.level * 0.1) {
        return preferred;
    }

    return best;
}

// Which frequency region best represents each stem. Drums keep the full
// signal; bass is judged on sub-250 Hz energy; guitar/piano/other/vocals are
// judged above 250 Hz so low-frequency bleed cannot masquerade as an
// instrument.
function get_stem_band(name) {
    if (name === "drums") {
        return "full";
    }

    if (name === "bass") {
        return "low";
    }

    return "high";
}

// Decide whether a stem contains a real instrument anywhere in the song.
// A piano stem made entirely of low-frequency bleed has a high p99 in the
// full band but almost nothing above 250 Hz, so it is rejected here.
function is_stem_active(analysis, max_band_level) {
    if (analysis.onsets.length === 0) {
        return false;
    }

    const max_level = max_band_level[analysis.band];

    if (max_level <= 0) {
        return false;
    }

    const min_ratio = analysis.name === "piano"
        ? DEMUCS_PIANO_ACTIVE_RATIO
        : DEMUCS_ACTIVE_RATIO;

    if (analysis.level < max_level * min_ratio) {
        return false;
    }

    if (analysis.band === "high" &&
        analysis.high_fraction < DEMUCS_HIGH_BAND_MIN_FRACTION) {
        return false;
    }

    if (analysis.name === "piano" &&
        analysis.high_fraction < DEMUCS_PIANO_MIN_HIGH_FRACTION) {
        return false;
    }

    if (analysis.name === "bass" && analysis.high_fraction > 0.6) {
        return false;
    }

    return true;
}

async function build_demucs_map(buffer, on_status) {
    const separated = await separate_stem_envelopes(buffer, on_status);
    const stem_count = separated.stem_count;
    const stem_names = stem_count >= 6 ? DEMUCS_STEM_NAMES_6 : DEMUCS_STEM_NAMES_4;

    const analyses = [];

    for (let s = 0; s < stem_count; s++) {
        const name = stem_names[s] || ("stem " + s);
        const band = get_stem_band(name);
        on_status("Finding " + name + " onsets...");

        const result = detect_onsets_from_energy(
            separated.envelopes[band][s],
            separated.frames_per_second
        );

        const total_energy = separated.band_energy.low[s] +
            separated.band_energy.high[s];
        const high_fraction = total_energy > 0
            ? separated.band_energy.high[s] / total_energy
            : 0;

        analyses.push({
            stem: s,
            name: name,
            band: band,
            onsets: result.onsets,
            level: result.level,
            high_fraction: high_fraction
        });
    }

    const max_band_level = {
        full: 0,
        low: 0,
        high: 0
    };

    for (let i = 0; i < analyses.length; i++) {
        const analysis = analyses[i];
        max_band_level[analysis.band] = Math.max(
            max_band_level[analysis.band],
            analysis.level
        );
    }

    // Note travel speed still follows the full-mix tempo.
    on_status("Measuring tempo...");
    const mix_analysis = detect_beat_times(buffer);
    const events = [];

    if (analyses.length === 0) {
        return {
            events: events,
            interval: mix_analysis.interval,
            stems: true,
            stem_count: stem_count,
            lane_sources: [],
            lane_fallbacks: []
        };
    }

    const assignments = [];
    const groups = new Map();
    const mapping = [];
    const counts = [];
    const lane_sources = new Array(CHANNELS).fill(null);
    const lane_fallbacks = new Array(CHANNELS).fill(false);

    for (let i = 0; i < DESIRED_INSTRUMENTS.length; i++) {
        const instrument = DESIRED_INSTRUMENTS[i];
        const mapped_index = stem_count >= 6 ? instrument.stem6 : instrument.stem4;

        let source = null;

        if (mapped_index !== null && mapped_index < analyses.length) {
            const mapped = analyses[mapped_index];

            if (is_stem_active(mapped, max_band_level)) {
                source = mapped;
            }
        }

        let fallback = false;

        if (!source && FALLBACK_MISSING_INSTRUMENTS) {
            const active = [];

            for (let j = 0; j < analyses.length; j++) {
                if (is_stem_active(analyses[j], max_band_level)) {
                    active.push(analyses[j]);
                }
            }

            source = choose_fallback_source(active, instrument, 0);
            fallback = source !== null;
        }

        if (!source) {
            mapping.push(instrument.name + " <- none");
            counts.push(instrument.name + "=0");
            continue;
        }

        lane_sources[instrument.channel] = source.name;
        lane_fallbacks[instrument.channel] = fallback;

        const assignment = {
            instrument: instrument,
            source: source,
            fallback: fallback,
            times: []
        };

        assignments.push(assignment);

        if (!groups.has(source.stem)) {
            groups.set(source.stem, []);
        }

        groups.get(source.stem).push(assignment);
    }

    for (const group of groups.values()) {
        const source = group[0].source;
        const natives = [];
        const fallbacks = [];

        for (let i = 0; i < group.length; i++) {
            if (group[i].fallback) {
                fallbacks.push(group[i]);
            } else {
                natives.push(group[i]);
            }
        }

        // A channel whose instrument is present keeps the full stem rhythm.
        for (let i = 0; i < natives.length; i++) {
            const assignment = natives[i];
            const gap = INSTRUMENT_MIN_GAP[assignment.instrument.channel] || MIN_NOTE_GAP;
            assignment.times = thin_onsets(source.onsets, gap);
        }

        // Fallback channels borrow the most prominent instrument, but take
        // onsets the native channel did not use so two lanes don't mirror
        // each other.
        if (fallbacks.length > 0) {
            let available = source.onsets;

            if (natives.length > 0) {
                const used = [];

                for (let i = 0; i < natives.length; i++) {
                    const times = natives[i].times;
                    for (let j = 0; j < times.length; j++) {
                        used.push(times[j]);
                    }
                }

                used.sort((a, b) => a - b);
                available = [];

                for (let i = 0; i < source.onsets.length; i++) {
                    const time = source.onsets[i];
                    if (!is_near_sorted(time, used, DEMUCS_FALLBACK_DEDUPE)) {
                        available.push(time);
                    }
                }

                // If the native channel covered the whole stem, fall back to
                // sharing the original onsets rather than leaving a lane empty.
                if (available.length === 0) {
                    available = source.onsets;
                }
            }

            for (let i = 0; i < fallbacks.length; i++) {
                const assignment = fallbacks[i];
                const gap = INSTRUMENT_MIN_GAP[assignment.instrument.channel] || MIN_NOTE_GAP;
                const share = [];

                for (let j = i; j < available.length; j += fallbacks.length) {
                    share.push(available[j]);
                }

                assignment.times = thin_onsets(share, gap);
            }
        }

        for (let i = 0; i < group.length; i++) {
            const assignment = group[i];
            const times = assignment.times || [];

            for (let j = 0; j < times.length; j++) {
                events.push({
                    time: times[j],
                    channel: assignment.instrument.channel
                });
            }

            mapping.push(
                assignment.instrument.name + " <- " + source.name +
                (assignment.fallback ? " (fallback)" : "")
            );
            counts.push(assignment.instrument.name + "=" + times.length);
        }
    }

    events.sort((a, b) => a.time - b.time);

    const interval = mix_analysis.interval > 0 ? mix_analysis.interval : 0.5;

    console.log("Instrument mapping: " + mapping.join(", "));
    console.log("Instrument notes: " + counts.join(", "));

    return {
        events: events,
        interval: interval,
        stems: true,
        stem_count: stem_count,
        lane_sources: lane_sources,
        lane_fallbacks: lane_fallbacks
    };
}

function use_song_map(buffer, map) {
    song_buffer = buffer;
    beat_interval = map.interval;
    update_fret_speed();
    spawn_interval = MIN_NOTE_GAP;
    selected_beats = map.events;
    beat_index = 0;
    beats_loaded = true;
    combo = 0;
    max_combo = 0;
    last_milestone = 0;
    lane_source_names = map.lane_sources || [];
    lane_fallback_flags = map.lane_fallbacks || [];
    current_instrument_map = map.stems ? map : null;
    update_save_map_button();

    console.log(
        "Beat analysis: ~" + (60 / beat_interval).toFixed(1) + " BPM, " +
        selected_beats.length + " notes selected" +
        (map.manual
            ? " from a manual map."
            : map.stems
                ? " from Demucs stems."
                : " from the BPM grid.")
    );
}

// Keep the neck's approach animation in time with the track: one fret
// cell per beat, so faster songs visibly rush the neck toward the player.
function update_fret_speed() {
    const duration = beat_interval > 0.05 ? beat_interval : 2;
    document.documentElement.style.setProperty("--fret-duration", duration.toFixed(3) + "s");
}

function reset_fret_speed() {
    document.documentElement.style.setProperty("--fret-duration", "2s");
}

function stop_song() {
    if (song_source) {
        song_source.onended = null;

        try {
            song_source.stop();
        } catch (error) {
            // Already stopped
        }

        song_source.disconnect();
        song_source = null;
    }

    if (song_gain) {
        song_gain.disconnect();
        song_gain = null;
    }

    song_started = false;
    song_starting = false;
    beat_index = 0;
    persist_best_score();
    score = 0;
    combo = 0;
    max_combo = 0;
    last_milestone = 0;
    attempt_broken = false;
    finish_banner = null;
    set_playing_state(false);

    active_notes.length = 0;
    clear_effects();
    hide_celebrations();

    last_time = performance.now();
    update_editor_controls();
}

async function decode_audio_blob(blob) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    let analysis_context;
    try {
        analysis_context = new AudioContextClass({ sampleRate: DEMUCS_SAMPLE_RATE });
    } catch (error) {
        analysis_context = new AudioContextClass();
    }

    let buffer = null;

    try {
        buffer = await analysis_context.decodeAudioData(await blob.arrayBuffer());
    } catch (decode_error) {
        // Some browsers refuse to resample long files to the requested
        // analysis rate. Retry at the context's native rate; the Demucs
        // chunk loader resamples on the fly.
        console.warn("Could not decode at 44.1 kHz; retrying at the native rate.", decode_error);
        await analysis_context.close();

        analysis_context = new AudioContextClass();
        buffer = await analysis_context.decodeAudioData(await blob.arrayBuffer());
    }

    await analysis_context.close();
    return buffer;
}

async function handle_song_upload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
        return;
    }

    if (song_loading) {
        // A second file cannot be analysed while the first chart is still
        // being built.
        event.target.value = "";
        return;
    }

    if (demucs_running) {
        event.target.value = "";
        return;
    }

    if (editor_mode) {
        cancel_manual_editor();
    }

    const is_note_map_file = function (file) {
        return /\.(dmap|json)$/i.test(file.name) ||
            file.type === "application/json";
    };

    const map_file = files.find(is_note_map_file) || null;
    const file = files.find(function (item) {
        return !is_note_map_file(item);
    }) || null;

    if (!file) {
        // A map selected without audio waits for the matching song.
        event.target.value = "";

        if (map_file) {
            await load_note_map_file(map_file);
        }

        return;
    }

    const status = document.getElementById("song-name");
    let paired_map = null;

    // When audio and a .dmap are selected together, pair them explicitly.
    if (map_file) {
        try {
            paired_map = await read_note_map_file(map_file);
        } catch (error) {
            console.warn("Could not read the selected note map.", error);

            if (status) {
                status.textContent = "Not a valid note map file";
            }

            event.target.value = "";
            return;
        }
    }

    event.target.value = "";
    await load_audio_source(
        file,
        file.name,
        file.type,
        file.lastModified,
        paired_map
    );
}

async function load_audio_source(blob, display_name, mime_type, last_modified, paired_map_data) {
    const status = document.getElementById("song-name");

    if (status) {
        status.textContent = "Loading " + display_name + "...";
    }

    song_loading = true;
    stop_song();
    update_demucs_button();

    try {
        const buffer = await decode_audio_blob(blob);

        if (status) {
            status.textContent = "Analysing beats...";
        }

        current_song_blob = blob;
        current_song_info = {
            name: display_name,
            size: blob.size,
            lastModified: last_modified || 0,
            duration: buffer.duration
        };

        // Let the status text paint before processing
        await new Promise((resolve) => setTimeout(resolve, 20));

        let map = null;
        let map_data = null;

        if (paired_map_data) {
            map_data = paired_map_data;
        } else if (pending_note_map &&
            note_map_matches_song(pending_note_map, current_song_info)) {
            map_data = pending_note_map;
        }

        if (map_data) {
            map = note_map_to_chart(map_data);

            if (map) {
                pending_note_map = null;
                use_song_map(buffer, map);
            }
        }

        if (!map) {
            if (status) {
                status.textContent = "Building BPM chart...";
            }

            map = build_bpm_map(buffer);
            use_song_map(buffer, map);
        }

        if (status) {
            const suffix = map && map.manual
                ? " (manual map)"
                : map && map.stems
                    ? " (instrument map)"
                    : " (BPM chart)";

            status.textContent = display_name + suffix;
        }
    } catch (error) {
        console.warn("Could not load audio.", error);
        clear_loaded_song();

        if (status) {
            status.textContent = "Could not read that audio file";
        }
    } finally {
        song_loading = false;
        update_demucs_button();
    }
}

function normalize_song_name(name) {
    return String(name || "")
        .toLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function note_map_matches_song(data, song_info) {
    if (!data || !data.song || !song_info) {
        return false;
    }

    const map_song = data.song;
    const name_match = normalize_song_name(map_song.name) !== "" &&
        normalize_song_name(map_song.name) === normalize_song_name(song_info.name);
    const has_size = typeof map_song.size === "number" && map_song.size > 0;
    const has_duration = typeof map_song.duration === "number" && map_song.duration > 0;
    const size_match = has_size && song_info.size &&
        map_song.size === song_info.size;
    const duration_match = has_duration && song_info.duration &&
        Math.abs(map_song.duration - song_info.duration) <= 0.5;

    if (name_match) {
        return true;
    }

    if (size_match && duration_match) {
        return true;
    }

    if (size_match && !has_duration) {
        return true;
    }

    if (duration_match && !has_size) {
        return true;
    }

    return !has_size && !has_duration && name_match;
}

function note_map_to_chart(data) {
    if (!data ||
        (data.format !== NOTE_MAP_FORMAT && data.format !== NOTE_MAP_LEGACY_FORMAT) ||
        data.version !== NOTE_MAP_VERSION ||
        !Array.isArray(data.events)) {
        return null;
    }

    const events = [];

    for (let i = 0; i < data.events.length; i++) {
        const event = data.events[i];
        const time = Number(event && event.time);
        const channel = Number(event && event.channel);

        if (!Number.isFinite(time) || time < 0 ||
            !Number.isInteger(channel) || channel < 0 || channel >= CHANNELS) {
            continue;
        }

        events.push({ time: time, channel: channel });
    }

    if (events.length === 0) {
        return null;
    }

    events.sort(function (a, b) {
        return a.time - b.time;
    });

    return {
        events: events,
        interval: Number(data.interval) > 0 ? Number(data.interval) : 0.5,
        stems: true,
        stem_count: Number(data.stem_count) || 0,
        manual: data.manual === true,
        lane_sources: Array.isArray(data.lane_sources) ? data.lane_sources.slice(0, CHANNELS) : [],
        lane_fallbacks: Array.isArray(data.lane_fallbacks) ? data.lane_fallbacks.slice(0, CHANNELS) : []
    };
}

function array_buffer_to_base64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk_size = 0x8000;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunk_size) {
        binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + chunk_size)
        );
    }

    return btoa(binary);
}

function base64_to_bytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function serialize_note_map(map, song_info) {
    return {
        format: NOTE_MAP_FORMAT,
        version: NOTE_MAP_VERSION,
        generated_by: "Demucs 6-stem",
        song: {
            name: song_info.name,
            size: song_info.size,
            last_modified: song_info.lastModified || 0,
            duration: song_info.duration
        },
        interval: map.interval,
        stem_count: map.stem_count || 0,
        manual: map.manual === true,
        lane_sources: map.lane_sources || [],
        lane_fallbacks: map.lane_fallbacks || [],
        events: map.events.map(function (event) {
            return {
                time: Number(event.time.toFixed(4)),
                channel: event.channel
            };
        })
    };
}

async function read_note_map_file(file) {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!note_map_to_chart(data)) {
        throw new Error("not a valid note map");
    }

    return data;
}

async function load_note_map_file(file) {
    const status = document.getElementById("song-name");

    try {
        const data = await read_note_map_file(file);
        const chart = note_map_to_chart(data);

        // Self-contained .dmap: decode the embedded audio and load it with
        // the note map. No separate song selection is needed.
        if (data.audio && typeof data.audio === "string") {
            try {
                const audio_bytes = base64_to_bytes(data.audio);
                const audio_type = data.audio_type || "audio/mpeg";
                const audio_name = data.audio_name ||
                    (data.song && data.song.name) ||
                    file.name.replace(/\.dmap$/i, ".mp3");
                const audio_blob = new Blob([audio_bytes], { type: audio_type });

                pending_note_map = null;
                await load_audio_source(
                    audio_blob,
                    audio_name,
                    audio_type,
                    data.song && data.song.last_modified,
                    data
                );
                update_demucs_button();
                return;
            } catch (audio_error) {
                console.warn("Could not load embedded audio; waiting for the matching song.", audio_error);
            }
        }

        if (current_song_info && note_map_matches_song(data, current_song_info)) {
            pending_note_map = null;
            apply_instrument_map(chart, chart.manual ? "Manual map" : "Instrument map");
        } else {
            pending_note_map = data;
            clear_loaded_song();

            if (status) {
                const target = data.song && data.song.name
                    ? data.song.name
                    : "the matching audio file";
                status.textContent = "Note map loaded - load " + target;
            }
        }

        update_demucs_button();
    } catch (error) {
        console.warn("Could not load note map.", error);

        if (status) {
            status.textContent = "Not a valid note map file";
        }
    }
}

function update_save_map_button() {
    const button = document.getElementById("save-map-button");
    if (!button) {
        return;
    }

    button.hidden = editor_mode || !current_instrument_map || !current_song_info;
}

async function download_current_note_map() {
    if (!current_instrument_map || !current_song_info) {
        return;
    }

    const button = document.getElementById("save-map-button");
    const button_text = button ? button.textContent : "";

    if (button) {
        button.disabled = true;
        button.textContent = "Saving...";
    }

    try {
        const data = serialize_note_map(current_instrument_map, current_song_info);

        if (current_song_blob) {
            try {
                const audio_bytes = await current_song_blob.arrayBuffer();
                data.audio = array_buffer_to_base64(audio_bytes);
                data.audio_type = current_song_blob.type || "audio/mpeg";
                data.audio_name = current_song_info.name;
            } catch (error) {
                console.warn("Could not embed audio in the note map.", error);
            }
        }

        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const base_name = current_song_info.name.replace(/\.[^.]+$/, "");

        link.href = url;
        link.download = base_name + ".dmap";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = button_text;
        }
    }
}

function show_demucs_overlay() {
    const overlay = document.getElementById("demucs-overlay");
    const status = document.getElementById("demucs-overlay-status");
    const fill = document.getElementById("demucs-progress-fill");

    if (status) {
        status.textContent = "Loading Demucs...";
    }

    if (fill) {
        fill.style.width = "0%";
    }

    if (overlay) {
        overlay.hidden = false;
    }
}

function update_demucs_overlay(message) {
    const status = document.getElementById("demucs-overlay-status");
    const fill = document.getElementById("demucs-progress-fill");

    if (status) {
        status.textContent = message;
    }

    if (fill) {
        const match = /\((\d+)%\)/.exec(message);
        if (match) {
            fill.style.width = match[1] + "%";
        }
    }
}

function hide_demucs_overlay() {
    const overlay = document.getElementById("demucs-overlay");
    if (overlay) {
        overlay.hidden = true;
    }
}

function apply_instrument_map(map, label) {
    if (!song_buffer) {
        return;
    }

    current_instrument_map = map;
    update_save_map_button();

    stop_song();
    use_song_map(song_buffer, map);

    const status = document.getElementById("song-name");
    if (status) {
        status.textContent = label + " ready";
    }

    update_demucs_button();
    update_save_map_button();
}

function clear_loaded_song() {
    stop_song();
    song_buffer = null;
    current_song_info = null;
    current_song_blob = null;
    selected_beats = [];
    beat_index = 0;
    beats_loaded = false;
    lane_source_names = [];
    lane_fallback_flags = [];
    current_instrument_map = null;

    reset_fret_speed();
    update_save_map_button();
    update_demucs_button();
}

function update_manual_button() {
    const button = document.getElementById("manual-button");
    if (!button) {
        return;
    }

    button.disabled = !song_buffer || song_loading || demucs_running || editor_mode;
    button.textContent = editor_mode ? "Recording..." : "Manual map";
}

function update_editor_controls() {
    const panel = document.getElementById("editor-controls");
    const count = document.getElementById("editor-count");
    const save = document.getElementById("editor-save");
    const rec = document.getElementById("editor-rec");

    if (panel) {
        panel.hidden = !editor_mode;
    }

    if (count) {
        count.textContent = "Notes: " + manual_notes.length;
    }

    if (save) {
        save.disabled = manual_notes.length === 0;
    }

    if (rec) {
        rec.classList.toggle("recording", editor_mode && song_started);
    }
}

function build_manual_map() {
    const events = manual_notes.slice().sort(function (a, b) {
        return a.time - b.time;
    });

    return {
        events: events,
        interval: beat_interval > 0 ? beat_interval : 0.5,
        stems: true,
        stem_count: 0,
        manual: true,
        lane_sources: [],
        lane_fallbacks: []
    };
}

function record_manual_note(channel) {
    if (!editor_mode || !song_started) {
        return;
    }

    const time = get_song_time();

    if (time < 0) {
        return;
    }

    for (let i = 0; i < manual_notes.length; i++) {
        const note = manual_notes[i];

        if (note.channel === channel && Math.abs(note.time - time) < 0.06) {
            return;
        }
    }

    manual_notes.push({ time: time, channel: channel });

    const circle = get_circle_center(channel);
    circle_flash_timers[channel] = CIRCLE_FLASH_DURATION;
    draw_effect(circle.x, circle.y, get_circle_radius());
    play_hit_sound(channel);
    update_editor_controls();
}

function start_manual_editor() {
    if (!song_buffer || song_loading || demucs_running || editor_mode) {
        return;
    }

    editor_mode = true;
    manual_notes = [];
    selected_beats = [];
    beat_index = 0;
    beats_loaded = false;
    lane_source_names = [];
    lane_fallback_flags = [];
    current_instrument_map = null;
    active_notes.length = 0;
    circle_flash_timers.fill(0);
    circle_hit_timers.fill(0);

    update_editor_controls();
    update_demucs_button();
    update_save_map_button();

    const status = document.getElementById("song-name");
    if (status) {
        status.textContent = "Manual map - press 1-4 to record";
    }

    stop_song();
    start_song();
}

function replay_manual_editor() {
    if (!editor_mode || !song_buffer) {
        return;
    }

    stop_song();
    start_song();
    update_editor_controls();
}

async function save_manual_editor() {
    if (!editor_mode || !song_buffer || manual_notes.length === 0) {
        return;
    }

    const button = document.getElementById("editor-save");
    if (button) {
        button.disabled = true;
        button.textContent = "Saving...";
    }

    current_instrument_map = build_manual_map();
    update_save_map_button();

    try {
        await download_current_note_map();

        const status = document.getElementById("song-name");
        if (status) {
            status.textContent = "Manual .dmap saved";
        }
    } finally {
        if (button) {
            button.textContent = "Save .dmap";
        }

        update_editor_controls();
    }
}

function exit_manual_editor() {
    if (!editor_mode) {
        return;
    }

    const map = manual_notes.length > 0 ? build_manual_map() : null;

    editor_mode = false;
    manual_notes = [];
    update_editor_controls();
    update_manual_button();
    update_demucs_button();

    stop_song();

    if (song_buffer) {
        const next_map = map || build_bpm_map(song_buffer);
        use_song_map(song_buffer, next_map);

        const status = document.getElementById("song-name");
        if (status) {
            status.textContent = map ? "Manual map ready" : "BPM chart";
        }
    }

    update_save_map_button();
}

function cancel_manual_editor() {
    if (!editor_mode) {
        return;
    }

    editor_mode = false;
    manual_notes = [];
    update_editor_controls();
    update_manual_button();
    update_demucs_button();
    update_save_map_button();
}

function update_demucs_button() {
    update_manual_button();

    const button = document.getElementById("demucs-button");
    if (!button) {
        return;
    }

    if (demucs_running) {
        button.textContent = "Demucs...";
        button.disabled = true;
        return;
    }

    const has_instrument_chart = lane_source_names.some(function (source) {
        return source !== null;
    });

    button.disabled = !DEMUCS_ENABLED || !song_buffer || song_loading || editor_mode;
    button.textContent = has_instrument_chart ? "Re-run Demucs" : "Demucs";
    button.title = "Analyse stems with Demucs (slow)";
}

async function run_demucs_separation() {
    if (!DEMUCS_ENABLED || !song_buffer || song_loading || demucs_running) {
        return;
    }

    const status = document.getElementById("song-name");
    const buffer = song_buffer;

    demucs_running = true;
    update_demucs_button();
    show_demucs_overlay();

    let map = null;

    try {
        map = await build_demucs_map(buffer, function (message) {
            if (status) {
                status.textContent = message;
            }

            update_demucs_overlay(message);
        });
    } catch (error) {
        console.warn("Demucs separation failed.", error);
        if (status) {
            status.textContent = "Demucs failed - keeping BPM chart";
        }
    } finally {
        demucs_running = false;
        await release_demucs_session();
        hide_demucs_overlay();
        update_demucs_button();
    }

    if (!map || map.events.length === 0) {
        if (status && map) {
            status.textContent = "Demucs found no instrument notes";
        }
        return;
    }

    if (song_buffer !== buffer) {
        return;
    }

    // Do not switch the loaded song to the instrument chart automatically.
    // The Demucs run produces a portable note map; the BPM chart stays active
    // until the user loads that map.
    current_instrument_map = map;
    update_save_map_button();
    update_demucs_button();

    if (status) {
        status.textContent = "Demucs note map ready - Save map to download it";
    }
}

function start_song() {
    if (song_loading || song_started || song_starting) {
        return;
    }

    if (!song_buffer) {
        return;
    }

    const audio = get_audio_context();
    if (!audio) {
        return;
    }

    function begin_playback() {
        if (!song_starting) {
            return;
        }

        song_starting = false;
        song_started = true;
        beat_index = 0;
        score = 0;
        combo = 0;
        max_combo = 0;
        last_milestone = 0;
        attempt_broken = false;
        finish_banner = null;
        tick = 0;
        spawn_timer = 0;
        circle_flash_timers.fill(0);
        circle_hit_timers.fill(0);

        // Pre-roll: normal playback travels notes from the top while the
        // song is silent, so notes at t=0 are playable and every note starts
        // at the far edge. The manual editor starts immediately so recording
        // can begin as soon as the audio does.
        const lead_time = editor_mode
            ? 0.1
            : LEAD_BEATS * (beat_interval > 0 ? beat_interval : 0.5);
        song_start_time = audio.currentTime + Math.max(0.1, lead_time);

        song_gain = audio.createGain();
        song_gain.gain.value = SONG_VOLUME;
        song_gain.connect(audio.destination);

        song_source = audio.createBufferSource();
        song_source.buffer = song_buffer;
        song_source.connect(song_gain);
        song_source.onended = () => {
            finish_song();
        };
        song_source.start(song_start_time);
        set_playing_state(true);
        update_editor_controls();
    }

    song_starting = true;

    // Wait until the context is actually running before choosing a start
    // time; otherwise the source can start late and the whole song shifts
    // relative to the note clock.
    if (audio.state === "running") {
        begin_playback();
    } else {
        audio.resume().then(begin_playback).catch(() => {
            song_starting = false;
            song_started = false;
        });
    }
}

function get_song_time() {
    if (!song_started || !audio_context) {
        return 0;
    }

    // Compensate for output latency so notes land with the sound heard.
    // This is negative during the pre-roll before the audio starts.
    const latency = audio_context.outputLatency || 0;
    return audio_context.currentTime - song_start_time - latency;
}

function spawn_beat_notes() {
    const now = get_song_time();
    const travel_length = get_travel_length();
    const travel_time = LEAD_BEATS * beat_interval;
    const note_speed = travel_length / travel_time;
    const lead = travel_time;

    while (beat_index < selected_beats.length) {
        const event = selected_beats[beat_index];
        const beat = event.time;
        const hit_time = beat + sync_offset;
        const spawn_at = hit_time - lead;

        if (spawn_at > now) {
            break;
        }

        beat_index++;
        const late = now - spawn_at;

        // Never drop a note in partway down the lane. If we missed its
        // spawn window, skip it; the first playable notes start at the top.
        if (late > 0.25) {
            continue;
        }

        const note = new Note(event.channel, note_speed, hit_time);
        note.t = 0;
        active_notes.push(note);
    }
}

function get_audio_context() {
    if (!SOUND_ENABLED) {
        return null;
    }

    if (audio_context === null) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            return null;
        }
        audio_context = new AudioContextClass();
    }

    if (audio_context.state === "suspended") {
        audio_context.resume();
    }

    return audio_context;
}

// Shared master bus with a soft limiter so louder, overlapping hits don't clip
function get_audio_destination(audio) {
    if (audio_master === null) {
        audio_master = audio.createDynamicsCompressor();
        audio_master.threshold.value = -14;
        audio_master.knee.value = 18;
        audio_master.ratio.value = 8;
        audio_master.attack.value = 0.003;
        audio_master.release.value = 0.15;
        audio_master.connect(audio.destination);
    }

    return audio_master;
}

// Karplus-Strong plucked-string synthesis, rendered into a cached buffer.
// "muted" gives the short dead-string thud used for misplays.
function create_pluck_buffer(audio, frequency, muted) {
    const key = frequency.toFixed(2) + (muted ? ":muted" : ":open");
    const cached = pluck_cache.get(key);
    if (cached) {
        return cached;
    }

    const sample_rate = audio.sampleRate;
    const duration = muted ? 0.14 : 1.1;
    const length = Math.floor(sample_rate * duration);
    const period = Math.max(2, Math.round(sample_rate / frequency));

    const buffer = audio.createBuffer(1, length, sample_rate);
    const data = buffer.getChannelData(0);
    const ring = new Float32Array(period);

    // Excitation: a burst of noise, one period long
    for (let i = 0; i < period; i++) {
        ring[i] = Math.random() * 2 - 1;
    }

    const decay = muted ? 0.85 : 0.994;
    let index = 0;

    for (let i = 0; i < length; i++) {
        const current = ring[index];
        const next = ring[(index + 1) % period];

        // Lowpass + damping, which is what makes it sound like a string
        ring[index] = (current + next) * 0.5 * decay;

        data[i] = current;
        index = (index + 1) % period;
    }

    // Fade the tail so the buffer does not end with a click
    const fade = Math.min(Math.floor(sample_rate * 0.05), length);
    for (let i = 0; i < fade; i++) {
        data[length - 1 - i] *= i / fade;
    }

    pluck_cache.set(key, buffer);
    return buffer;
}

// Scale a synthesised hit to a consistent peak and fade its tail so it
// cannot click when the buffer ends.
function finish_hit_buffer(buffer, peak) {
    const data = buffer.getChannelData(0);
    let max = 0;

    for (let i = 0; i < data.length; i++) {
        max = Math.max(max, Math.abs(data[i]));
    }

    if (max > 0) {
        const scale = peak / max;
        for (let i = 0; i < data.length; i++) {
            data[i] *= scale;
        }
    }

    const fade = Math.min(Math.floor(buffer.sampleRate * 0.03), data.length);
    for (let i = 0; i < fade; i++) {
        data[data.length - 1 - i] *= i / fade;
    }

    return buffer;
}

// Kick/snare-style thump: a pitch-dropping sine plus a short noise burst.
function create_drum_buffer(audio, muted) {
    const sample_rate = audio.sampleRate;
    const duration = muted ? 0.12 : 0.22;
    const length = Math.floor(sample_rate * duration);
    const buffer = audio.createBuffer(1, length, sample_rate);
    const data = buffer.getChannelData(0);

    let phase = 0;

    for (let i = 0; i < length; i++) {
        const t = i / sample_rate;
        const envelope = Math.exp(-t * (muted ? 42 : 17));
        const frequency = 45 + 115 * Math.exp(-t * 28);

        phase += (2 * Math.PI * frequency) / sample_rate;

        const thump = Math.sin(phase) * 0.85;
        const noise = (Math.random() * 2 - 1) *
            (muted ? 0.12 : 0.4) * Math.exp(-t * (muted ? 60 : 34));

        data[i] = (thump + noise) * envelope;
    }

    return finish_hit_buffer(buffer, muted ? 0.55 : 0.9);
}

// Round sub-bass with a touch of second harmonic so it survives small speakers.
function create_bass_buffer(audio, frequency, muted) {
    const sample_rate = audio.sampleRate;
    const duration = muted ? 0.16 : 0.55;
    const length = Math.floor(sample_rate * duration);
    const buffer = audio.createBuffer(1, length, sample_rate);
    const data = buffer.getChannelData(0);
    const attack = muted ? 0.002 : 0.008;

    for (let i = 0; i < length; i++) {
        const t = i / sample_rate;
        const envelope = Math.exp(-t * (muted ? 34 : 6.2)) *
            Math.min(1, t / attack);
        const fundamental = Math.sin(2 * Math.PI * frequency * t);
        const second = Math.sin(4 * Math.PI * frequency * t) * 0.35;
        const third = Math.sin(6 * Math.PI * frequency * t) * 0.08;

        data[i] = (fundamental + second + third) * envelope;
    }

    return finish_hit_buffer(buffer, muted ? 0.5 : 0.85);
}

// Soft hammered-piano tone built from a few decaying partials.
function create_piano_buffer(audio, frequency, muted) {
    const sample_rate = audio.sampleRate;
    const duration = muted ? 0.14 : 0.8;
    const length = Math.floor(sample_rate * duration);
    const buffer = audio.createBuffer(1, length, sample_rate);
    const data = buffer.getChannelData(0);
    const partials = [1, 2, 3, 4.2, 5.4, 7.1];
    const weights = [1, 0.55, 0.3, 0.14, 0.08, 0.04];
    const decay = muted ? 36 : 4.3;

    for (let i = 0; i < length; i++) {
        const t = i / sample_rate;
        const envelope = Math.exp(-t * decay) * Math.min(1, t / 0.004);
        let sample = 0;

        for (let k = 0; k < partials.length; k++) {
            sample += weights[k] *
                Math.sin(2 * Math.PI * frequency * partials[k] * t);
        }

        data[i] = sample * envelope * 0.5;
    }

    return finish_hit_buffer(buffer, muted ? 0.45 : 0.8);
}

function get_hit_buffer(audio, channel, muted) {
    const index = channel % CHANNELS;
    const style = CHANNEL_SOUND_STYLES[index];
    const frequency = CHANNEL_FREQUENCIES[index];
    const key = style + ":" + frequency.toFixed(2) + (muted ? ":muted" : ":open");
    const cached = hit_buffer_cache.get(key);

    if (cached) {
        return cached;
    }

    let buffer;

    if (style === "drums") {
        buffer = create_drum_buffer(audio, muted);
    } else if (style === "bass") {
        buffer = create_bass_buffer(audio, frequency, muted);
    } else if (style === "piano") {
        buffer = create_piano_buffer(audio, frequency, muted);
    } else {
        buffer = create_pluck_buffer(audio, frequency, muted);
    }

    hit_buffer_cache.set(key, buffer);
    return buffer;
}

function play_channel_note(channel, muted) {
    const audio = get_audio_context();
    if (!audio) return;

    const buffer = get_hit_buffer(audio, channel, muted);
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const now = audio.currentTime;

    source.buffer = buffer;
    gain.gain.setValueAtTime(muted ? MISS_VOLUME : HIT_VOLUME, now);
    source.connect(gain);
    gain.connect(get_audio_destination(audio));
    source.start(now);
    source.stop(now + buffer.duration);
}

// Per-instrument hit and miss sounds
function play_hit_sound(channel) {
    play_channel_note(channel, false);
}

function play_miss_sound(channel) {
    play_channel_note(channel, true);
}

function get_hit_click_buffer(audio) {
    if (hit_click_buffer) {
        return hit_click_buffer;
    }

    const sample_rate = audio.sampleRate;
    const length = Math.max(1, Math.floor(sample_rate * 0.05));
    const buffer = audio.createBuffer(1, length, sample_rate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
        const t = i / sample_rate;
        const attack = Math.min(1, t / 0.0015);
        const envelope = Math.exp(-t * 90) * attack;
        const tone = Math.sin(2 * Math.PI * 1250 * t) * 0.55 +
            Math.sin(2 * Math.PI * 2500 * t) * 0.22;
        const noise = (Math.random() * 2 - 1) * 0.35 * Math.exp(-t * 260);

        data[i] = (tone + noise) * envelope * 0.7;
    }

    hit_click_buffer = buffer;
    return buffer;
}

function play_hit_click() {
    if (!SOUND_ENABLED) {
        return;
    }

    const audio = get_audio_context();

    if (!audio) {
        return;
    }

    const source = audio.createBufferSource();
    const gain = audio.createGain();

    source.buffer = get_hit_click_buffer(audio);
    gain.gain.value = HIT_CLICK_VOLUME;
    source.connect(gain);
    gain.connect(get_audio_destination(audio));
    source.start();
}

function channel_up(channel)
{
    if (!song_started) {
        return;
    }

    // An empty lane has no dedicated instrument in this song; ignore presses.
    if (lane_source_names.length > 0 && lane_source_names[channel] === null) {
        return;
    }

    const circle = get_circle_center(channel);
    const circle_radius = get_circle_radius();
    let hits = 0;

    // Light up the circle briefly on every press
    circle_flash_timers[channel] = CIRCLE_FLASH_DURATION;

    // Iterate backwards so splicing doesn't skip entries
    for (let i = active_notes.length - 1; i >= 0; i--) {
        const note = active_notes[i];

        if (note.channel !== channel) {
            continue;
        }

        let can_hit;
        if (note.hit_time !== null) {
            // The press is accepted when the note's centre is touching the
            // circle's centre (t = 1), not when their rectangles first overlap.
            const t_window = HIT_WINDOW / note.travel_time;
            can_hit = Math.abs(note.t - 1) <= t_window;
        } else {
            // Fallback timing for notes spawned without a beat time
            can_hit = note.hits_circle(circle.x, circle.y, circle_radius);
        }

        if (can_hit) {
            active_notes.splice(i, 1);
            score++;
            combo++;
            max_combo = Math.max(max_combo, combo);
            hits++;
            draw_effect(circle.x, circle.y, circle_radius);
        }
    }

    if (hits > 0) {
        // Keep the feedback on the hit circle instead of zooming the stage.
        circle_hit_timers[channel] = CIRCLE_HIT_DURATION;
        play_hit_click();
        check_milestone();
        play_hit_sound(channel);
    } else {
        break_combo(null);
        play_miss_sound(channel);
    }
}

// Shared entry point for keyboard and physical sensor input.
function handle_lane_input(channel) {
    if (editor_mode) {
        record_manual_note(channel);
        return;
    }

    if (!song_started && !song_starting) {
        start_song();
        return;
    }

    // Ignore input during the countdown so fidgeting cannot break the combo.
    if (!song_started || get_song_time() < 0) {
        return;
    }

    channel_up(channel);
}

window.handle_lane_input = handle_lane_input;

function get_particle_sprite(colour)
{
    let sprite = particle_sprite_cache[colour];
    if (sprite) {
        return sprite;
    }

    sprite = document.createElement("canvas");
    sprite.width = PARTICLE_SPRITE_SIZE;
    sprite.height = PARTICLE_SPRITE_SIZE;

    const sprite_ctx = sprite.getContext("2d");
    const centre = PARTICLE_SPRITE_SIZE / 2;
    const gradient = sprite_ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);

    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.2, colour);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

    sprite_ctx.fillStyle = gradient;
    sprite_ctx.fillRect(0, 0, PARTICLE_SPRITE_SIZE, PARTICLE_SPRITE_SIZE);

    particle_sprite_cache[colour] = sprite;
    return sprite;
}

function release_effect(effect)
{
    for (let i = 0; i < effect.particles.length; i++) {
        particle_pool.push(effect.particles[i]);
    }

    effect.particles.length = 0;
    effect_pool.push(effect);
}

function clear_effects()
{
    for (let i = 0; i < effects.length; i++) {
        release_effect(effects[i]);
    }

    effects.length = 0;
}

// Spawns a burst of fire particles around a hit circle. The particles live
// for EFFECT_DURATION seconds and are advanced/drawn by update_and_draw_effects.
function draw_effect(x, y, radius)
{
    const particles = [];

    for (let i = 0; i < EFFECT_PARTICLES; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = radius * (0.75 + Math.random() * 0.45);
        const speed = 60 + Math.random() * 140;

        // Reuse a pooled particle object instead of allocating a new one
        const particle = particle_pool.pop() || {};
        particle.x = x + Math.cos(angle) * distance;
        particle.y = y + Math.sin(angle) * distance;
        particle.vx = Math.cos(angle) * speed * 0.5;
        particle.vy = Math.sin(angle) * speed * 0.5 - 40; // slight upward bias
        particle.size = 4 + Math.random() * 8;
        particle.sprite = get_particle_sprite(
            FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)]
        );

        particles.push(particle);
    }

    const effect = effect_pool.pop() || { particles: [] };
    effect.particles = particles;
    effect.age = 0;
    effect.duration = EFFECT_DURATION;
    effects.push(effect);
}

function update_and_draw_effects(delta_time)
{
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; // makes overlapping fire glow

    for (let i = effects.length - 1; i >= 0; i--) {
        const effect = effects[i];
        effect.age += delta_time;

        if (effect.age >= effect.duration) {
            effects.splice(i, 1);
            release_effect(effect);
            continue;
        }

        const progress = effect.age / effect.duration; // 0 -> 1 over the lifetime
        ctx.globalAlpha = 1 - progress;                 // fade out (once per burst)

        for (let particle of effect.particles) {
            particle.x += particle.vx * delta_time;
            particle.y += particle.vy * delta_time;
            particle.vy -= 60 * delta_time;                 // fire drifts upwards
            particle.vx *= 1 - 1.5 * delta_time;            // horizontal drag
            particle.vy *= 1 - 0.5 * delta_time;

            const size = particle.size * 2 * (1 - progress * 0.5);
            ctx.drawImage(
                particle.sprite,
                particle.x - size / 2,
                particle.y - size / 2,
                size,
                size
            );
        }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
}

// Runs the expensive code paths once at startup so the browser's one-off
// initialisation happens during load instead of on the first channel_up().
function warm_up_canvas()
{
    // draw_effect + update_and_draw_effects exercises the particle
    // allocation/JIT path, the "lighter" composite mode, and the arc draw
    // calls. Two passes give the JIT a chance to tier up.
    for (let i = 0; i < 2; i++) {
        draw_effect(10, 10, 10);
        update_and_draw_effects(0);
    }

    // Also warm the first-use paths of the fill/stroke helpers
    draw_circle(10, 10, 10, CHANNEL_COLOURS[0]);
    draw_square(10, 10, 10, 10, CHANNEL_COLOURS[0]);

    // Discard the warm-up work before the first visible frame
    clear_effects();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Don't count warm-up time towards the first frame's delta
    last_time = performance.now();
}

// Create/resume the audio context on the first real user gesture so the
// first hit is not silent while the browser unlocks audio. Also pre-render
// the per-instrument hit buffers so the first press doesn't hitch.
if (SOUND_ENABLED) {
    const unlock_audio = () => {
        const audio = get_audio_context();
        if (!audio) return;

        for (let channel = 0; channel < CHANNELS; channel++) {
            get_hit_buffer(audio, channel, false);
            get_hit_buffer(audio, channel, true);
        }

        get_hit_click_buffer(audio);
    };

    document.addEventListener("pointerdown", unlock_audio, { once: true });
    document.addEventListener("keydown", unlock_audio, { once: true });
}

// Debug keyboard input: 1-4 map to channels 0-3
if (DEBUG_INPUT_ENABLED) {
    const DEBUG_CHANNEL_KEYS = { "1": 0, "2": 1, "3": 2, "4": 3 };

    document.addEventListener("keydown", (event) => {
        if (event.repeat) {
            return;
        }

        const channel = DEBUG_CHANNEL_KEYS[event.key];
        if (channel === undefined) {
            return;
        }

        event.preventDefault();
        handle_lane_input(channel);
    });
}

// Sync calibration: ] delays notes, [ makes them earlier, 0 resets
if (DEBUG_INPUT_ENABLED) {
    document.addEventListener("keydown", (event) => {
        if (event.key === "[" || event.key === "]") {
            set_sync_offset(sync_offset + (event.key === "]" ? 0.01 : -0.01));
        } else if (event.key === "0") {
            set_sync_offset(0);
        } else {
            return;
        }

        event.preventDefault();
    });
}

// Start the song on the first intentional game gesture (audio autoplay
// policy). Upload controls, browser function keys and modifier shortcuts
// must not count as "press any key".
function is_upload_control_target(target) {
    return target instanceof Element && target.closest(".song-controls") !== null;
}

function is_editor_control_target(target) {
    return target instanceof Element && target.closest("#editor-controls") !== null;
}

function is_function_key(key) {
    return /^F([1-9]|1[0-2])$/.test(key);
}

function is_text_control_target(target) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tag = target.tagName;

    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        tag === "BUTTON" || target.isContentEditable;
}

document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 ||
        is_upload_control_target(event.target) ||
        is_editor_control_target(event.target) ||
        editor_mode) {
        return;
    }

    start_song();
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" ||
        is_function_key(event.key) ||
        event.ctrlKey || event.altKey || event.metaKey ||
        is_text_control_target(event.target) ||
        editor_mode) {
        return;
    }

    start_song();
});

// Escape stops playback and returns to the ready screen
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (song_started || song_starting)) {
        stop_song();
        event.preventDefault();
    }
});

const song_upload = document.getElementById("song-upload");
if (song_upload) {
    song_upload.addEventListener("change", handle_song_upload);
}

const demucs_button = document.getElementById("demucs-button");
if (demucs_button) {
    demucs_button.addEventListener("click", function () {
        run_demucs_separation();
    });
}

const save_map_button = document.getElementById("save-map-button");
if (save_map_button) {
    save_map_button.addEventListener("click", function () {
        download_current_note_map();
    });
}

const manual_button = document.getElementById("manual-button");
if (manual_button) {
    manual_button.addEventListener("click", function () {
        start_manual_editor();
    });
}

const editor_replay = document.getElementById("editor-replay");
if (editor_replay) {
    editor_replay.addEventListener("click", function () {
        replay_manual_editor();
    });
}

const editor_save = document.getElementById("editor-save");
if (editor_save) {
    editor_save.addEventListener("click", function () {
        save_manual_editor();
    });
}

const editor_exit = document.getElementById("editor-exit");
if (editor_exit) {
    editor_exit.addEventListener("click", function () {
        exit_manual_editor();
    });
}

const demucs_hide = document.getElementById("demucs-hide");
if (demucs_hide) {
    demucs_hide.addEventListener("click", function () {
        hide_demucs_overlay();
    });
}

const fx_toggle = document.getElementById("fx-toggle");
if (fx_toggle) {
    fx_toggle.addEventListener("click", function () {
        toggle_effects();
    });
}

init_effects_setting();
load_best_score();
build_note_sprites();
build_dino_sprites();

set_orientation("portrait");
warm_up_canvas();
update_demucs_button();
update_save_map_button();
update_editor_controls();
gameLoop();