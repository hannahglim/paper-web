const IMAGES = [
  "IMG_145CA08760A5-1 3.png",
  "IMG_145CA08760A5-1 4.png",
  "IMG_145CA08760A5-1 5.png",
  "IMG_145CA08760A5-1 6.png",
  "IMG_145CA08760A5-2 2.png",
  "IMG_145CA08760A5-2 4.png",
  "IMG_145CA08760A5-3 1.png",
  "IMG_145CA08760A5-4 1.png",
  "JPEG image-4148-A0E4-CE-0 1.png",
  "JPEG image-4148-A0E4-CE-1 6.png",
  "JPEG image-4148-A0E4-CE-1 7-1.png",
  "JPEG image-4148-A0E4-CE-1 7.png",
  "JPEG image-4148-A0E4-CE-10 1.png",
  "JPEG image-4148-A0E4-CE-12 1.png",
  "JPEG image-4148-A0E4-CE-2 2.png",
  "JPEG image-4148-A0E4-CE-2 3.png",
  "JPEG image-4148-A0E4-CE-3 1.png",
  "JPEG image-4148-A0E4-CE-3 2.png",
  "JPEG image-4148-A0E4-CE-4 2.png",
  "JPEG image-4148-A0E4-CE-4 4.png",
  "JPEG image-4148-A0E4-CE-5 2.png",
  "JPEG image-4148-A0E4-CE-5 3.png",
  "JPEG image-4148-A0E4-CE-6 2.png",
  "JPEG image-4148-A0E4-CE-7 1.png",
  "JPEG image-4148-A0E4-CE-8 1.png",
  "JPEG image-4148-A0E4-CE-8 2.png",
  "JPEG image-4148-A0E4-CE-9 1.png",
  "JPEG image-4644-A1AD-0D-0 1.png",
  "JPEG image-46E4-B826-14-0 2 1.png",
  "JPEG image-46E4-B826-14-0 2 2.png",
  "JPEG image-46E4-B826-14-0 2 3.png",
  "Mask group-1.png",
  "Mask group.png",
  "aros copy.png",
  "barcametro copy.png",
  "bauhaus2 copy.png",
  "berlinfilm copy.png",
  "clothes copy.png",
  "golf copy.png",
  "kaffe copy.png",
  "louisiana copy.png",
  "museo copy.png",
  "prolog copy.png",
  "quilt copy.png",
  "riso1 copy.png",
  "vinterjazz copy.png",
  "w+k copy.png",
  "welles copy.png",
];

// Realtime backend (PartyKit). Localhost during `npm run dev`; update the
// prod host after your first `partykit deploy`.
const REALTIME = {
  host: location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "localhost:1999"
    : "paper-web.hannahglim.partykit.dev",
  room: "paper-web",
};

const MIN_DISPLAY_WIDTH = 286;
const MAX_DISPLAY_WIDTH = 682;
const MAX_TILT_DEG = 14;

const COLUMN_WIDTH = 380;
const CANVAS_HEIGHT = 5500;
// TOP_PADDING is bigger than BOTTOM_PADDING to keep the top row of photos
// clear of the intro copy pinned at the top-left of the viewport.
const TOP_PADDING = 240;
const BOTTOM_PADDING = 40;
// Bounds on individual gaps between images in a column. MAX_OVERLAP_RATIO
// caps overlap at 55% of the shorter image's height so nothing gets buried;
// MAX_GAP caps positive gaps so we never leave a big white strip.
const MAX_OVERLAP_RATIO = 0.55;
const MAX_GAP = 35;

const canvas = document.getElementById("canvas");
const canvasFrame = document.getElementById("canvas-frame");
let saved = {}; // populated from PartyKit server before rendering
let zCounter = 1;
// Visual scale applied to the canvas via CSS transform, updated on resize.
// Coord system stays 1600 wide; drag/cursor math divides by this to keep
// the authoritative coordinate space untouched.
let viewScale = 1;

// Photo elements keyed by filename so we can apply remote updates in place.
const photoRefs = new Map();
// Remote users' cursor DOM nodes, keyed by connection id.
const remoteCursors = new Map();
let socket = null;
let myId = null;

// Fixed canvas width so every visitor renders the same layout.
const canvasWidth = 1600;
const cols = Math.max(2, Math.floor(canvasWidth / COLUMN_WIDTH));
const cellW = canvasWidth / cols;

canvas.style.width = canvasWidth + "px";
canvas.style.height = CANVAS_HEIGHT + "px";

// Scale the canvas up/down to fit the viewport width. Clamped so images stay
// readable on smaller desktops and don't get absurd on ultrawide monitors.
const MIN_VIEW_SCALE = 0.7;
const MAX_VIEW_SCALE = 1.3;
function applyResponsiveScale() {
  viewScale = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, window.innerWidth / canvasWidth));
  canvas.style.transform = `scale(${viewScale})`;
  canvasFrame.style.width = (canvasWidth * viewScale) + "px";
  canvasFrame.style.height = (CANVAS_HEIGHT * viewScale) + "px";
}
applyResponsiveScale();
window.addEventListener("resize", applyResponsiveScale);

Promise.all([Promise.all(IMAGES.map(preload)), connectRealtime()]).then(([sizes, initialPhotos]) => {
  saved = initialPhotos;
  // Start from each image's natural pixel dimensions so relative sizes stay
  // truthful - a 4000x3000 source really is bigger than an 800x600 source.
  // Newly added " copy.png" sources are exported at a smaller DPI, so 2x them
  // up front to match the visual scale of the rest.
  let items = sizes.map((info) => {
    const boost = info.filename.endsWith(" copy.png") ? 2 : 1;
    return { ...info, width: info.w * boost, height: info.h * boost };
  });

  // Pick a single global scale so everything fits: sized against a reference
  // image (median of the collection). MIN/MAX_DISPLAY_WIDTH define the target
  // side length for that median image, and everything else scales relative to
  // it in true proportion.
  const sortedSides = items.map((i) => Math.sqrt(i.width * i.height)).sort((a, b) => a - b);
  const medianSide = sortedSides[Math.floor(sortedSides.length / 2)];
  const targetMedianSide = (MIN_DISPLAY_WIDTH + MAX_DISPLAY_WIDTH) / 2;
  let globalScale = targetMedianSide / medianSide;

  // Column-width check uses the 90th percentile, not the absolute max - one
  // outlier photo shouldn't drag everyone else's size down.
  const columnCap = cellW * 0.9;
  const sortedWidths = items.map((i) => i.width * globalScale).sort((a, b) => a - b);
  const p90Width = sortedWidths[Math.floor(sortedWidths.length * 0.9)];
  if (p90Width > columnCap) {
    globalScale *= columnCap / p90Width;
  }

  items = items.map((i) => ({ ...i, width: i.width * globalScale, height: i.height * globalScale }));

  // Any individual outlier still over the column cap gets clamped alone.
  items = items.map((i) => {
    if (i.width > columnCap) {
      const s = columnCap / i.width;
      return { ...i, width: columnCap, height: i.height * s };
    }
    return i;
  });

  const unplaced = items.filter((item) => !saved[item.filename]);
  const columns = Array.from({ length: cols }, () => []);
  const columnContentHeight = new Array(cols).fill(0);

  const byHeightDescending = unplaced.slice().sort((a, b) => b.height - a.height);
  byHeightDescending.forEach((item) => {
    let col = 0;
    for (let c = 1; c < cols; c++) {
      if (columnContentHeight[c] < columnContentHeight[col]) col = c;
    }
    columns[col].push(item);
    columnContentHeight[col] += item.height;
  });
  for (let c = 0; c < cols; c++) columns[c] = shuffle(columns[c]);

  const targetColHeight = CANVAS_HEIGHT - TOP_PADDING - BOTTOM_PADDING;

  // Per column, the minimum permitted gap is set by the shortest image in
  // that column - overlapping more than MAX_OVERLAP_RATIO of it would bury it.
  const columnMinGaps = columns.map((colItems) => {
    if (colItems.length === 0) return 0;
    const minH = Math.min(...colItems.map((i) => i.height));
    return -MAX_OVERLAP_RATIO * minH;
  });

  // If any column can't fit even at max overlap, scale everything uniformly so
  // it does. Bin-packing balances columns closely, so this scale is usually 1.
  let fitScale = 1;
  columns.forEach((colItems, col) => {
    if (colItems.length === 0) return;
    const gapCount = colItems.length + 1;
    const maxAllowedContent = targetColHeight - columnMinGaps[col] * gapCount;
    if (columnContentHeight[col] > maxAllowedContent) {
      fitScale = Math.min(fitScale, maxAllowedContent / columnContentHeight[col]);
    }
  });
  if (fitScale < 1) {
    items = items.map((i) => ({ ...i, width: i.width * fitScale, height: i.height * fitScale }));
    for (let c = 0; c < cols; c++) {
      columnContentHeight[c] *= fitScale;
      columnMinGaps[c] *= fitScale;
    }
  }

  columns.forEach((colItems, col) => {
    if (colItems.length === 0) return;
    const gapCount = colItems.length + 1;
    const budget = targetColHeight - columnContentHeight[col];
    const gaps = distributeGaps(budget, gapCount, columnMinGaps[col], MAX_GAP);

    let y = TOP_PADDING + gaps[0];
    colItems.forEach((item, idx) => {
      placePhoto(item, col, y + item.height / 2);
      y += item.height + gaps[idx + 1];
    });
  });

  items.filter((item) => saved[item.filename]).forEach((item) => placePhoto(item));

  // If the server hadn't heard about some photos yet, seed our positions so
  // future visitors converge on the same canonical layout.
  const missing = items.filter((item) => !initialPhotos[item.filename]);
  if (missing.length > 0) {
    const seed = {};
    missing.forEach((item) => {
      const el = photoRefs.get(item.filename);
      if (!el) return;
      seed[item.filename] = {
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        rot: parseFloat(el.dataset.baseRot),
      };
    });
    send({ type: "initial", photos: seed });
  }
});

function distributeGaps(total, count, minEach, maxEach) {
  // Preserve the min (overlap cap) always, but allow gaps to stretch past
  // maxEach when the column would otherwise end short of CANVAS_HEIGHT. This
  // keeps every column reaching the bottom, even the ones bin-packing left
  // with less content.
  const clampedTotal = Math.max(minEach * count, total);
  const baseGap = clampedTotal / count;
  const effectiveMaxEach = Math.max(maxEach, baseGap);
  const maxDelta = Math.min(effectiveMaxEach - baseGap, baseGap - minEach);
  const rawDeltas = Array.from({ length: count }, () => (Math.random() - 0.5) * 2 * maxDelta);
  const deltaMean = rawDeltas.reduce((a, b) => a + b, 0) / count;
  return rawDeltas.map((d) => Math.max(minEach, Math.min(effectiveMaxEach, baseGap + d - deltaMean)));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function preload(filename) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        filename,
        w: img.naturalWidth,
        h: img.naturalHeight,
        metric: Math.sqrt(img.naturalWidth * img.naturalHeight),
      });
    img.onerror = () => resolve({ filename, w: 1, h: 1, metric: 1 });
    img.src = filename;
  });
}

function placePhoto({ filename, width }, col, centerY) {
  const wrapper = document.createElement("div");
  wrapper.className = "photo";

  const img = document.createElement("img");
  img.src = filename;
  img.draggable = false;
  img.alt = "";
  wrapper.appendChild(img);

  wrapper.style.width = width + "px";

  const state = saved[filename] || randomPositionInColumn(width, col, centerY);
  setRotation(wrapper, state.rot);
  wrapper.style.left = state.x + "px";
  wrapper.style.top = state.y + "px";
  wrapper.dataset.baseRot = state.rot;

  canvas.appendChild(wrapper);
  photoRefs.set(filename, wrapper);
  makeDraggable(wrapper, filename);
}

function randomPositionInColumn(width, col, centerY) {
  const jitterRange = cellW * 0.9;
  const centerX = col * cellW + cellW / 2 + (Math.random() - 0.5) * jitterRange;
  const rot = (Math.random() - 0.5) * 36;

  // Keep photos fully inside the horizontal bounds - there's no horizontal
  // scroll, so anything hanging past the edge would just be clipped.
  const half = width / 2;
  const x = Math.max(half, Math.min(canvasWidth - half, centerX));

  return { x, y: centerY, rot };
}

function setRotation(el, rot) {
  el.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
}

function makeDraggable(el, filename) {
  // Tilt is a function of how far you've dragged sideways from where you
  // pressed down, capped at MAX_TILT_DEG. Displacement-based (not velocity)
  // so the rotation stays put when you stop moving - whatever angle is on
  // screen the moment you release is what sticks.
  const TILT_SENSITIVITY = 0.12;

  let dragging = false;
  let startX, startY, elX, elY;
  let currentTilt = 0;
  let baseRot = parseFloat(el.dataset.baseRot);

  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    el.style.zIndex = ++zCounter;

    startX = e.clientX;
    startY = e.clientY;
    elX = parseFloat(el.style.left);
    elY = parseFloat(el.style.top);
    currentTilt = 0;
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    // Divide viewport-space deltas by viewScale so the photo tracks the
    // pointer 1:1 in the canvas's coordinate space regardless of visual scale.
    const dxCanvas = (e.clientX - startX) / viewScale;
    const dyCanvas = (e.clientY - startY) / viewScale;

    const half = el.offsetWidth / 2;
    const x = Math.max(half, Math.min(canvasWidth - half, elX + dxCanvas));
    const y = elY + dyCanvas;

    currentTilt = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, dxCanvas * TILT_SENSITIVITY));

    el.style.left = x + "px";
    el.style.top = y + "px";
    setRotation(el, baseRot + currentTilt);

    sendPhotoMove(filename, x, y, baseRot + currentTilt);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    el.releasePointerCapture(e.pointerId);

    baseRot += currentTilt;
    currentTilt = 0;
    setRotation(el, baseRot);

    send({
      type: "photo",
      filename,
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      rot: baseRot,
      commit: true,
    });
  }

  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

// Throttle to ~25 Hz so drag / cursor streams don't flood the socket.
function throttle(fn, ms) {
  let last = 0;
  let pending = null;
  let pendingArgs = null;
  return (...args) => {
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!pending) {
        pending = setTimeout(() => {
          last = performance.now();
          pending = null;
          fn(...pendingArgs);
        }, wait);
      }
    }
  };
}

const sendCursor = throttle((x, y) => send({ type: "cursor", x, y }), 40);
const sendPhotoMove = throttle(
  (filename, x, y, rot) => send({ type: "photo", filename, x, y, rot, commit: false }),
  40,
);

// Open the PartyKit socket and resolve with the initial photo positions.
// Falls back to an empty layout if the connection fails so the page still
// renders offline.
function connectRealtime() {
  return new Promise((resolve) => {
    const proto = REALTIME.host.startsWith("localhost") || REALTIME.host.startsWith("127.")
      ? "ws"
      : "wss";
    const url = `${proto}://${REALTIME.host}/party/${REALTIME.room}`;
    let resolved = false;

    function open() {
      socket = new WebSocket(url);

      socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === "init") {
          myId = msg.you;
          for (const [id, c] of Object.entries(msg.cursors || {})) {
            spawnRemoteCursor(id, c.color, c.x, c.y);
          }
          if (!resolved) {
            resolved = true;
            resolve(msg.photos || {});
          }
        } else if (msg.type === "sync") {
          for (const [fn, pos] of Object.entries(msg.photos || {})) {
            applyRemotePhoto(fn, pos.x, pos.y, pos.rot);
          }
        } else if (msg.type === "join") {
          spawnRemoteCursor(msg.id, msg.color);
        } else if (msg.type === "leave") {
          removeRemoteCursor(msg.id);
        } else if (msg.type === "cursor") {
          moveRemoteCursor(msg.id, msg.x, msg.y);
        } else if (msg.type === "photo") {
          applyRemotePhoto(msg.filename, msg.x, msg.y, msg.rot);
        }
      };

      socket.onerror = () => {
        if (!resolved) {
          resolved = true;
          resolve({});
        }
      };

      socket.onclose = () => {
        // Naive reconnect: retry after 2s. Won't resend "initial" since our
        // client-side seed only runs once during the boot Promise.
        setTimeout(open, 2000);
      };
    }

    open();
  });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function spawnRemoteCursor(id, color, x, y) {
  if (id === myId || remoteCursors.has(id)) return;
  const el = document.createElement("div");
  el.className = "remote-cursor";
  // Same blur profile as the local pink cursor (0.95 at center → 0.55 at 35%
  // → fully transparent at 100%), just recoloured. Using rgba() rather than
  // 8-digit hex to avoid the browser painting an opaque square when the last
  // stop isn't parsed with alpha.
  el.style.background =
    `radial-gradient(circle closest-side at 50% 50%, ${hexToRgba(color, 0.95)} 0%, ` +
    `${hexToRgba(color, 0.55)} 35%, ${hexToRgba(color, 0)} 100%)`;
  el.style.left = ((x ?? -9999) | 0) + "px";
  el.style.top = ((y ?? -9999) | 0) + "px";
  // Start hidden until we get a real cursor:move; the initial x/y from init
  // may be null (they haven't moved yet).
  const hasPos = x != null && y != null;
  if (!hasPos) el.classList.add("inactive");
  canvas.appendChild(el);
  remoteCursors.set(id, { el, lastMove: hasPos ? performance.now() : 0 });
}

function removeRemoteCursor(id) {
  const entry = remoteCursors.get(id);
  if (entry) {
    entry.el.remove();
    remoteCursors.delete(id);
  }
}

function moveRemoteCursor(id, x, y) {
  const entry = remoteCursors.get(id);
  if (!entry) return;
  entry.lastMove = performance.now();
  entry.el.style.left = x + "px";
  entry.el.style.top = y + "px";
  entry.el.classList.remove("inactive");
}

// Fade out any remote cursor that hasn't moved in the last minute. Checked
// on a cheap 2s interval; the CSS transition on .remote-cursor.inactive does
// the actual visual fade.
const CURSOR_IDLE_MS = 60_000;
setInterval(() => {
  const now = performance.now();
  remoteCursors.forEach((entry) => {
    if (!entry.lastMove) return;
    if (now - entry.lastMove > CURSOR_IDLE_MS) {
      entry.el.classList.add("inactive");
    }
  });
}, 2000);

function applyRemotePhoto(filename, x, y, rot) {
  const el = photoRefs.get(filename);
  if (!el) return;
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.dataset.baseRot = rot;
  setRotation(el, rot);
}

// Broadcast our cursor in canvas-local coordinates (the same coordinate
// space photos live in). getBoundingClientRect gives the canvas's current
// on-screen position accounting for both scroll and any responsive scale;
// dividing by viewScale unprojects back into canvas coords.
document.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  sendCursor((e.clientX - rect.left) / viewScale, (e.clientY - rect.top) / viewScale);
});

// Smooth scroll with tension: wheel input feeds a target position that the
// actual scroll eases toward each frame, giving vertical scrolling a weighted,
// elastic feel instead of snapping 1:1 with the wheel.
(function scrollTension() {
  const EASE = 0.11;
  // Speed (px per frame) above which the pink vignette is fully on. Below
  // this the class is dropped and the CSS transition fades it out - so the
  // fade begins as the tension animation is decelerating, not after it stops.
  const FADE_VELOCITY = 3;

  let targetY = window.scrollY;
  let currentY = window.scrollY;
  let running = false;

  // Slack so the pink holds even when the tension animation settles a hair
  // short of the true bottom - 99% of the way still counts as "at the end".
  const BOTTOM_SLACK = 60;
  function isAtBottom() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return currentY >= max - BOTTOM_SLACK;
  }

  // Pink vignette + corner text stay visible while scrolling fast enough OR
  // while sitting at the very bottom of the page (so reaching the end holds
  // the frame instead of fading it away).
  function setPink(active) {
    if (active || isAtBottom()) {
      document.body.classList.add("scrolling");
    } else {
      document.body.classList.remove("scrolling");
    }
  }

  // Intro copy is only sharp within the top 2% of the scrollable range AND
  // only after the pink vignette + corner text have faded ~80% away. When
  // scrolling back to the top, wait ~0.4s after the .scrolling class is
  // removed (the CSS fade is 0.5s) so the two states don't overlap.
  const introEl = document.querySelector(".intro");
  let introShowTimer = null;
  function updateIntro() {
    if (!introEl) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const threshold = Math.max(20, max * 0.02);
    const atTop = currentY <= threshold;
    const pinkOn = document.body.classList.contains("scrolling");

    if (atTop && !pinkOn) {
      if (introEl.classList.contains("hidden") && !introShowTimer) {
        introShowTimer = setTimeout(() => {
          introShowTimer = null;
          const stillAtTop = currentY <= Math.max(
            20,
            (document.documentElement.scrollHeight - window.innerHeight) * 0.02,
          );
          const stillPinkOff = !document.body.classList.contains("scrolling");
          if (stillAtTop && stillPinkOff) {
            introEl.classList.remove("hidden");
          }
        }, 400);
      }
    } else {
      if (introShowTimer) {
        clearTimeout(introShowTimer);
        introShowTimer = null;
      }
      introEl.classList.add("hidden");
    }
  }
  updateIntro();

  function tick() {
    const dy = targetY - currentY;
    if (Math.abs(dy) < 0.4) {
      currentY = targetY;
      window.scrollTo(0, currentY);
      setPink(false);
      updateIntro();
      running = false;
      return;
    }
    const step = dy * EASE;
    currentY += step;
    window.scrollTo(0, currentY);
    setPink(Math.abs(step) >= FADE_VELOCITY);
    updateIntro();
    requestAnimationFrame(tick);
  }

  window.addEventListener("wheel", (e) => {
    e.preventDefault();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    targetY = Math.max(0, Math.min(max, targetY + e.deltaY));
    setPink(true);
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }, { passive: false });

  // Keep target in sync if the user scrolls via keyboard, scrollbar, or
  // touch (anything that isn't the wheel we're intercepting).
  window.addEventListener("scroll", () => {
    if (!running) {
      targetY = window.scrollY;
      currentY = window.scrollY;
      setPink(false);
      updateIntro();
    }
  }, { passive: true });
})();
