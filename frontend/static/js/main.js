const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const stage = document.querySelector(".stage");

const CHANNELS = 4;
const CHANNEL_COLOURS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
const TITLE_BOUNDARY = 120;

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

// Open guitar strings: E2, A2, D3, G3 — one per channel
const GUITAR_NOTES = [82.41, 110.00, 146.83, 196.00];

var audio_context = null;
var audio_master = null;
var pluck_cache = new Map();

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

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(point.x, point.y);
        ctx.rotate(this.angle);
        draw_square(-this.width / 2, -this.height / 2, this.width, this.height, CHANNEL_COLOURS[this.channel]);
        ctx.restore();
    }
};

var active_notes = [];
var spawn_interval = 1; // minimum seconds between notes (updated from the tempo)
var spawn_timer = 0;

// Song used to drive note spawning
const SONG_VOLUME = 0.6;
const NOTE_SPEED = 200; // fallback speed, px per second in lane space
const LEAD_BEATS = 4;   // notes take this many beats to reach the circles
const MIN_NOTE_GAP = 0.35; // never spawn notes closer together than this (seconds)

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
var beats_loaded = false;
var selected_beats = [];
var beat_index = 0;

var song_buffer = null;
var song_source = null;
var song_gain = null;
var song_start_time = 0;

// Placeholder texture shown above a circle while it flashes
var placeholder_image = new Image();
placeholder_image.src = "/static/assets/placeholder.png";

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

// How close (in seconds) a press must be to the note's centre reaching the
// circle centre. Wider = more forgiving.
const HIT_WINDOW = 0.22;

// Predictive speed correction: if a note's projected arrival drifts from its
// target, it speeds up/slows down to converge instead of teleporting.
const NOTE_SYNC_MAX_CORRECTION = 0.6; // t units per second
const NOTE_SYNC_SNAP = 0.35;          // larger errors snap to the target

var circle_flash_timers = new Array(CHANNELS).fill(0);

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
    // Use more of the window; width is capped at 98vw and the height at 90vh
    const max_width = window.innerWidth * 0.98;
    const max_height = window.innerHeight * 0.90;
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
        ctx.beginPath();

        // Squash the circle along the direction the lane travels so it lies
        // on the same perspective plane as the notes.
        if (is_portrait()) {
            ctx.ellipse(x, y, radius, radius * CIRCLE_PERSPECTIVE, 0, 0, 2 * Math.PI);
        } else {
            ctx.ellipse(x, y, radius * CIRCLE_PERSPECTIVE, radius, 0, 0, 2 * Math.PI);
        }

        if (fill_colour) {
            ctx.globalAlpha = fill_alpha;
            ctx.fillStyle = fill_colour;
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        ctx.strokeStyle = "white";
        ctx.lineWidth = 5;
        ctx.stroke();
}

function draw_placeholder(circle, radius, alpha)
{
    if (!placeholder_image.complete || placeholder_image.naturalWidth === 0) {
        return;
    }

    const size = radius * 1.5;
    const center_x = circle.x;
    const center_y = circle.y - radius * 1.7;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(placeholder_image, center_x - size / 2, center_y - size / 2, size, size);
    ctx.restore();
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
    const width = Math.min(canvas.width * 0.86, 720);
    const height = 170;
    const x = (canvas.width - width) / 2;
    const y = canvas.height * 0.5 - height / 2;
    const radius = 20;

    ctx.save();
    ctx.fillStyle = "rgba(12, 12, 14, 0.78)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
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

    ctx.fillStyle = "#f3e5c8";
    ctx.font = "600 38px Arial";
    ctx.fillText(title, canvas.width / 2, y + 64);

    ctx.fillStyle = "rgba(255, 255, 255, 0.66)";
    ctx.font = "22px Arial";
    ctx.fillText(subtitle, canvas.width / 2, y + 118);

    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function gameLoop() {
    const delta_time = get_delta_time();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Temporary test rectangle
    ctx.fillStyle = "white";
    ctx.fillRect(0, TITLE_BOUNDARY, canvas.width, 5);
    
    ctx.font = "60px Arial";
    ctx.fillText("Score: " + score, canvas.width / 2 - ctx.measureText("Score: " + score).width / 2, TITLE_BOUNDARY / 2 + 20);

    if (DEBUG_INPUT_ENABLED) {
        ctx.font = "24px Arial";
        ctx.textAlign = "left";
        ctx.fillText(
            "sync " + Math.round(sync_offset * 1000) + "ms  ([ / ])",
            20,
            canvas.height - 24
        );
    }

    for (let i = 0; i < CHANNELS; i++) {
        circle_flash_timers[i] = Math.max(0, circle_flash_timers[i] - delta_time);
    }

    if (is_portrait()) {
        // Vertical lanes converging toward a vanishing point at the top
        const base_lane = canvas.width / CHANNELS;
        const near_y = get_circle_center(0).y;
        const extend_t = (canvas.height - TITLE_BOUNDARY) / (near_y - TITLE_BOUNDARY);

        // Fade the outer lines out with the guitar mask
        const line_fade = ctx.createLinearGradient(0, TITLE_BOUNDARY, 0, canvas.height);
        line_fade.addColorStop(0, "rgba(255, 255, 255, 1)");
        line_fade.addColorStop(0.80, "rgba(255, 255, 255, 1)");
        line_fade.addColorStop(0.92, "rgba(255, 255, 255, 0)");

        ctx.strokeStyle = line_fade;
        ctx.lineWidth = 5;

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
        line_fade.addColorStop(0, "rgba(255, 255, 255, 1)");
        line_fade.addColorStop(0.92, "rgba(255, 255, 255, 1)");
        line_fade.addColorStop(1, "rgba(255, 255, 255, 0)");

        ctx.strokeStyle = line_fade;
        ctx.lineWidth = 5;

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

    // Update and draw every note each frame, before spawning new ones
    for (let note of active_notes) {
        note.update(delta_time);
        note.draw();
    }

    update_and_draw_effects(delta_time);

    // Placeholder texture floats just above each flashing circle
    for (let i = 0; i < CHANNELS; i++) {
        const flash = circle_flash_timers[i] / CIRCLE_FLASH_DURATION;
        if (flash > 0) {
            draw_placeholder(get_circle_center(i), get_circle_radius(), flash);
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

    if (!song_buffer) {
        draw_prompt("NO SONG LOADED", "Use \u201cUpload song\u201d to choose an audio file");
    } else if (!song_started) {
        draw_prompt("PRESS ANY KEY TO START", "Song ready");
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
function detect_beat_times(buffer) {
    const sample_rate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);
    const frame_size = 1024;
    const hop = 256;
    const frame_count = Math.floor((samples.length - frame_size) / hop);
    const energy = new Float32Array(frame_count);

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

    let max_energy = 0;
    for (let i = 0; i < frame_count; i++) {
        max_energy = Math.max(max_energy, energy[i]);
    }

    const threshold = max_energy * 0.25;
    const frames_per_second = sample_rate / hop;
    const min_gap_frames = Math.floor(frames_per_second * 0.1);
    const peaks = [];
    let last_peak = -min_gap_frames;

    for (let i = 1; i < frame_count - 1; i++) {
        if (energy[i] > threshold && energy[i] >= energy[i - 1] && energy[i] >= energy[i + 1]) {
            if (i - last_peak >= min_gap_frames) {
                peaks.push({
                    time: (i * hop) / sample_rate,
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
    const grid = refine_beat_grid(energy, frames_per_second, buffer.duration, interval);
    interval = grid.interval;

    const beats = [];
    for (let t = grid.offset; t < buffer.duration; t += interval) {
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

function apply_song_buffer(buffer) {
    const analysis = detect_beat_times(buffer);

    song_buffer = buffer;
    beat_interval = analysis.interval;
    spawn_interval = MIN_NOTE_GAP;

    selected_beats = select_beats(analysis.beats);
    beat_index = 0;
    beats_loaded = true;

    console.log(
        "Beat analysis: ~" + (60 / beat_interval).toFixed(1) + " BPM, " +
        analysis.beats.length + " grid beats, " +
        selected_beats.length + " notes selected (min gap " +
        spawn_interval.toFixed(2) + "s)."
    );
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
    score = 0;

    active_notes.length = 0;
    clear_effects();

    last_time = performance.now();
}

async function handle_song_upload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
        return;
    }

    const status = document.getElementById("song-name");
    if (status) {
        status.textContent = "Loading " + file.name + "...";
    }

    try {
        const data = await file.arrayBuffer();

        if (status) {
            status.textContent = "Decoding " + file.name + "...";
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const analysis_context = new AudioContextClass();
        const buffer = await analysis_context.decodeAudioData(data);

        if (status) {
            status.textContent = "Analysing beats...";
        }

        // Let the status text paint before the synchronous analysis pass
        await new Promise((resolve) => setTimeout(resolve, 20));

        await analysis_context.close();

        stop_song();
        apply_song_buffer(buffer);

        if (status) {
            status.textContent = file.name + " (ready)";
        }
    } catch (error) {
        console.warn("Could not load uploaded song.", error);

        if (status) {
            status.textContent = "Could not read that audio file";
        }
    }

    // Allow selecting the same file again later
    event.target.value = "";
}

function start_song() {
    if (song_started || song_starting) {
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
        tick = 0;
        spawn_timer = 0;
        circle_flash_timers.fill(0);

        // Small scheduling lead so the first buffer chunk is ready
        song_start_time = audio.currentTime + 0.1;

        song_gain = audio.createGain();
        song_gain.gain.value = SONG_VOLUME;
        song_gain.connect(audio.destination);

        song_source = audio.createBufferSource();
        song_source.buffer = song_buffer;
        song_source.connect(song_gain);
        song_source.onended = () => {
            song_started = false;
            active_notes.length = 0;
            clear_effects();
        };
        song_source.start(song_start_time);
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

    // Compensate for output latency so notes land with the sound heard
    const latency = audio_context.outputLatency || 0;
    return Math.max(0, audio_context.currentTime - song_start_time - latency);
}

function spawn_beat_notes() {
    const now = get_song_time();
    const travel_length = get_travel_length();
    const travel_time = LEAD_BEATS * beat_interval;
    const note_speed = travel_length / travel_time;
    const lead = travel_time;

    while (beat_index < selected_beats.length) {
        const beat = selected_beats[beat_index];
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

        const note = new Note(Math.floor(Math.random() * CHANNELS), note_speed, hit_time);
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

function play_guitar_note(channel, muted) {
    const audio = get_audio_context();
    if (!audio) return;

    const frequency = GUITAR_NOTES[channel % GUITAR_NOTES.length];
    const buffer = create_pluck_buffer(audio, frequency, muted);
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

// A plucked open string for a hit, a muted string for a misplay
function play_hit_sound(channel) {
    play_guitar_note(channel, false);
}

function play_miss_sound(channel) {
    play_guitar_note(channel, true);
}

function channel_up(channel)
{
    if (!song_started) {
        return;
    }

    const circle = get_circle_center(channel);
    const circle_radius = get_circle_radius();
    let hit = false;

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
            hit = true;
            draw_effect(circle.x, circle.y, circle_radius);
        }
    }

    if (hit) {
        play_hit_sound(channel);
    } else {
        play_miss_sound(channel);
    }
}

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
// all plucked-string buffers so the first press doesn't hitch.
if (SOUND_ENABLED) {
    const unlock_audio = () => {
        const audio = get_audio_context();
        if (!audio) return;

        for (const frequency of GUITAR_NOTES) {
            create_pluck_buffer(audio, frequency, false);
            create_pluck_buffer(audio, frequency, true);
        }
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
        channel_up(channel);
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

// Start the song on the first user gesture (audio autoplay policy)
document.addEventListener("pointerdown", start_song);
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
        start_song();
    }
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

set_orientation("portrait");
warm_up_canvas();
gameLoop();