// PartyKit server for paper-web.
// Holds one global shared canvas: photo positions persisted via room storage,
// plus live cursor positions kept in memory per connected user.

// Fixed palette for remote cursors. Personal (own) cursor is always the pink
// SVG cursor on the client - these eight are only assigned to OTHER users.
// Server tracks which are in use so nothing repeats until a 9th visitor joins.
const CURSOR_COLORS = [
  "#2222dd", // blue
  "#6bde50", // green
  "#d5db4a", // lime
  "#d43a2d", // red
  "#7cdbc7", // teal
  "#d47a3a", // orange
  "#4b9de0", // sky
  "#7c1fda", // purple
];

export default class PaperWebServer {
  constructor(room) {
    this.room = room;
    this.photos = {}; // { filename: { x, y, rot } }
    this.cursors = {}; // { connectionId: { x, y, color } }
  }

  pickColor() {
    const inUse = new Set(Object.values(this.cursors).map((c) => c.color));
    for (const color of CURSOR_COLORS) {
      if (!inUse.has(color)) return color;
    }
    // 9+ visitors: reuse the palette starting from the top.
    return CURSOR_COLORS[Object.keys(this.cursors).length % CURSOR_COLORS.length];
  }

  async onStart() {
    const stored = await this.room.storage.get("photos");
    if (stored) this.photos = stored;
  }

  onConnect(conn) {
    const color = this.pickColor();
    this.cursors[conn.id] = { x: null, y: null, color };

    // Send this user their id, color, and the current world state.
    const otherCursors = {};
    for (const [id, c] of Object.entries(this.cursors)) {
      if (id !== conn.id) otherCursors[id] = c;
    }
    conn.send(JSON.stringify({
      type: "init",
      you: conn.id,
      color,
      photos: this.photos,
      cursors: otherCursors,
    }));

    // Announce them to everyone else.
    this.room.broadcast(
      JSON.stringify({ type: "join", id: conn.id, color }),
      [conn.id],
    );
  }

  onClose(conn) {
    delete this.cursors[conn.id];
    this.room.broadcast(JSON.stringify({ type: "leave", id: conn.id }));
  }

  async onMessage(raw, conn) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "cursor") {
      const c = this.cursors[conn.id];
      if (!c) return;
      c.x = msg.x;
      c.y = msg.y;
      this.room.broadcast(
        JSON.stringify({ type: "cursor", id: conn.id, x: msg.x, y: msg.y }),
        [conn.id],
      );
    } else if (msg.type === "photo") {
      // Overwrite is fine - last write wins if two people grab the same
      // photo simultaneously.
      this.photos[msg.filename] = { x: msg.x, y: msg.y, rot: msg.rot };
      this.room.broadcast(
        JSON.stringify({
          type: "photo",
          filename: msg.filename,
          x: msg.x,
          y: msg.y,
          rot: msg.rot,
          by: conn.id,
        }),
        [conn.id],
      );
      // Persist only on drag release to avoid storage thrash mid-drag.
      if (msg.commit) {
        await this.room.storage.put("photos", this.photos);
      }
    } else if (msg.type === "initial") {
      // First user seeds the canonical layout. Later joins whose "initial"
      // clashes with existing state are ignored per-photo, then a sync is
      // sent back so the client can converge on the authoritative positions.
      let changed = false;
      for (const [fn, pos] of Object.entries(msg.photos || {})) {
        if (!this.photos[fn]) {
          this.photos[fn] = pos;
          changed = true;
        }
      }
      if (changed) {
        await this.room.storage.put("photos", this.photos);
      }
      conn.send(JSON.stringify({ type: "sync", photos: this.photos }));
    }
  }
}
