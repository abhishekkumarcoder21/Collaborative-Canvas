# Architecture Documentation

This document explains the architectural decisions, data flows, and implementation details of the Collaborative Canvas system.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Principles](#core-principles)
3. [Data Model](#data-model)
4. [WebSocket Protocol](#websocket-protocol)
5. [Global Undo/Redo](#global-undoredo)
6. [Canvas Rendering](#canvas-rendering)
7. [Eraser Design](#eraser-design)
8. [Conflict Resolution](#conflict-resolution)
9. [Performance Optimizations](#performance-optimizations)
10. [Scaling Considerations](#scaling-considerations)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Client 1   │  │   Client 2   │  │   Client N   │          │
│  │              │  │              │  │              │          │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │          │
│  │ │ Canvas   │ │  │ │ Canvas   │ │  │ │ Canvas   │ │          │
│  │ │ Layers   │ │  │ │ Layers   │ │  │ │ Layers   │ │          │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │          │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │          │
│  │ │ WS Client│ │  │ │ WS Client│ │  │ │ WS Client│ │          │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          │     WebSocket (Socket.io)         │
          │                 │                 │
┌─────────▼─────────────────▼─────────────────▼───────────────────┐
│                          SERVER                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      Socket.io                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Room Manager                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │  │
│  │  │   Room A    │  │   Room B    │  │   Room N    │        │  │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │        │  │
│  │  │ │ Users   │ │  │ │ Users   │ │  │ │ Users   │ │        │  │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │        │  │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │        │  │
│  │  │ │ Drawing │ │  │ │ Drawing │ │  │ │ Drawing │ │        │  │
│  │  │ │ State   │ │  │ │ State   │ │  │ │ State   │ │        │  │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │        │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘        │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Principles

### 1. Server-Authoritative

The server is the **single source of truth**. All state changes flow through the server:

```
Client draws → Server validates → Server assigns sequence number → Broadcast to all
```

**Why?**
- Prevents conflicts between clients
- Enables consistent global undo/redo
- Simplifies reconnection logic

### 2. Immutable Operations

Strokes are **never modified** after creation. The `isUndone` flag determines visibility:

```javascript
// WRONG - mutating stroke
strokes = strokes.filter(s => s.id !== undoId);

// CORRECT - flagging as undone
stroke.isUndone = true;
```

**Why?**
- Undo/redo is O(1) - just flip a flag
- Simpler reasoning about state
- Enables potential history features

### 3. Ephemeral vs Committed Strokes

| Phase | Location | Authoritative | Visible To |
|-------|----------|---------------|------------|
| Active (drawing) | Client + Server preview | No | All (as preview) |
| Committed | Server operation log | Yes | All |

**Why?**
- Real-time feedback while drawing
- Server assigns final sequence number
- Clients discard previews when commit arrives

### 4. Deterministic Ordering

Every committed stroke has a **sequence number** assigned by the server:

```javascript
stroke.sequence = this.nextSequence(); // Monotonically increasing
```

All clients render strokes in sequence order, guaranteeing identical canvases.

---

## Data Model

### Stroke Object

```javascript
{
  id: "stroke_1737456789_abc123",  // Unique identifier
  userId: "socket_xyz",             // Who drew it
  tool: "brush" | "eraser",         // Tool type
  color: "#FF6B6B",                 // Stroke color
  width: 5,                         // Stroke width in pixels
  points: [                         // Array of points
    { x: 100, y: 150, t: 1737456789001 },
    { x: 102, y: 153, t: 1737456789015 },
    // ...
  ],
  timestamp: 1737456789000,         // When committed
  sequence: 42,                     // Server-assigned order
  isUndone: false                   // Visibility flag
}
```

### Room State

```javascript
{
  roomId: "my-room",
  users: [
    { id: "socket_abc", name: "Alice", color: "#FF6B6B", cursor: {x,y}, isDrawing: false },
    { id: "socket_def", name: "Bob", color: "#4ECDC4", cursor: {x,y}, isDrawing: true }
  ],
  drawing: {
    operationLog: [/* all strokes */],
    activeStrokes: [/* in-progress strokes */],
    canUndo: true,
    canRedo: false,
    sequenceCounter: 42
  }
}
```

---

## WebSocket Protocol

### Connection Flow

```
Client                          Server
   │                               │
   ├── connect ────────────────────►
   │                               │
   ◄────────────────── connected ──┤
   │                               │
   ├── room:join ──────────────────►
   │   { roomId, userName }        │
   │                               │
   ◄─────────── room:state ────────┤
   │   { user, state }             │
   │                               │
   │   (to other clients)          │
   ◄─────────── user:join ─────────┤
   │   { user }                    │
```

### Drawing Flow

```
Client A                        Server                        Client B
   │                               │                              │
   ├── stroke:start ───────────────►                              │
   │   {id, tool, color...}        │                              │
   │                               ├── stroke:preview ────────────►
   │                               │   {type: 'start', stroke}    │
   │                               │                              │
   ├── stroke:update ──────────────►                              │
   │   {id, points[]}              │                              │
   │                               ├── stroke:preview ────────────►
   │                               │   {type: 'update', points[]} │
   │                               │                              │
   ├── stroke:end ─────────────────►                              │
   │   {id}                        │                              │
   │                               │  (assign sequence number)    │
   │                               │                              │
   ◄──────────── stroke:commit ────┼── stroke:commit ─────────────►
   │   {stroke with sequence}      │   {stroke with sequence}     │
```

### Undo/Redo Flow

```
Client A                        Server                        Client B
   │                               │                              │
   ├── undo ───────────────────────►                              │
   │                               │  (find last non-undone)      │
   │                               │  (mark isUndone = true)      │
   │                               │  (push to redoStack)         │
   │                               │                              │
   ◄──────────── undo ─────────────┼── undo ──────────────────────►
   │   {strokeId, userName}        │   {strokeId, userName}       │
   │                               │                              │
   │  (mark stroke undone)         │                              │
   │  (re-render canvas)           │       (same on Client B)     │
```

---

## Global Undo/Redo

### The Challenge

Traditional undo is **per-user**: Alice undoes Alice's strokes, Bob undoes Bob's. 

**Global undo** means: undo removes the **most recent visible stroke**, regardless of who drew it.

### Implementation

#### Data Structures

```javascript
class DrawingState {
  operationLog = [];     // All strokes, ordered by sequence
  redoStack = [];        // Stack of undone stroke IDs
  sequenceCounter = 0;   // Monotonic counter
}
```

#### Undo Algorithm

```javascript
undo() {
  // 1. Find last non-undone stroke (reverse scan)
  for (let i = this.operationLog.length - 1; i >= 0; i--) {
    const stroke = this.operationLog[i];
    if (!stroke.isUndone) {
      // 2. Mark as undone
      stroke.isUndone = true;
      // 3. Push to redo stack
      this.redoStack.push(stroke.id);
      return stroke;
    }
  }
  return null; // Nothing to undo
}
```

#### Redo Algorithm

```javascript
redo() {
  if (this.redoStack.length === 0) return null;
  
  // 1. Pop from redo stack
  const strokeId = this.redoStack.pop();
  
  // 2. Find and restore
  const stroke = this.operationLog.find(s => s.id === strokeId);
  if (stroke) {
    stroke.isUndone = false;
    return stroke;
  }
  return null;
}
```

#### Redo Invalidation

**Critical**: Any new stroke clears the redo stack.

```javascript
endStroke(strokeId) {
  // ... commit stroke ...
  
  // CRITICAL: Clear redo stack
  this.redoStack = [];
}
```

**Why?** Without this, you'd have branching history:

```
A ─── B ─── C      (original)
          │
          └─ undo C
          │
A ─── B           (after undo)
          │
          ├─ redo C  (one branch)
          │
          └─ draw D  (another branch - conflict!)
```

By clearing redo on new operations, we maintain linear history.

---

## Canvas Rendering

### Layer Architecture

```
┌────────────────────────────────────┐
│      Layer 4: Cursors              │ ← pointer-events: none
├────────────────────────────────────┤
│      Layer 3: Active Strokes       │ ← touch/mouse events
├────────────────────────────────────┤
│      Layer 2: Committed Strokes    │
├────────────────────────────────────┤
│      Layer 1: Background (white)   │
└────────────────────────────────────┘
```

**Why layers?**

| Layer | Cleared When | Reason |
|-------|-------------|--------|
| Background | Never | Static white |
| Strokes | Undo/Redo/Resize | Contains all committed strokes |
| Active | Every active change | Ephemeral preview strokes |
| Cursors | Every frame (RAF) | Animated cursors |

### Smooth Curve Rendering

Points are connected using **quadratic Bezier curves** through midpoints:

```javascript
// Standard line drawing (jagged at corners)
ctx.lineTo(points[i].x, points[i].y);

// Quadratic curve through midpoints (smooth)
for (let i = 1; i < points.length - 1; i++) {
  const midX = (points[i].x + points[i + 1].x) / 2;
  const midY = (points[i].y + points[i + 1].y) / 2;
  ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
}
```

---

## Eraser Design

### The Problem

A naive eraser would **delete pixels** from the canvas. This breaks undo:

```
1. Draw stroke A
2. Draw stroke B (overlapping A)
3. Erase part of B (pixels deleted)
4. Undo → What happens? B is restored, but A's deleted pixels aren't.
```

### The Solution: Stroke-Based Erasing

The eraser is just **another stroke type** using `globalCompositeOperation`:

```javascript
if (tool === 'eraser') {
  ctx.globalCompositeOperation = 'destination-out';
  // Draw eraser stroke (removes pixels)
} else {
  ctx.globalCompositeOperation = 'source-over';
  // Normal drawing
}
```

**Undo works perfectly:**

```
1. Draw stroke A        → Log: [A]
2. Draw stroke B        → Log: [A, B]
3. Erase with stroke E  → Log: [A, B, E]
4. Undo                 → E.isUndone = true
5. Re-render            → Draw A, Draw B (E skipped) = Original!
```

The eraser stroke is stored like any other stroke. Undoing it re-renders without it, restoring the covered pixels.

---

## Conflict Resolution

### Strategy: No Conflicts

By design, we avoid conflicts entirely:

1. **No locking**: Users can draw anywhere simultaneously
2. **No merging**: Strokes don't merge or interact
3. **Overlapping allowed**: Strokes simply layer on top

### Ordering Guarantee

All clients render strokes in **sequence order**:

```javascript
const strokes = Array.from(this.committedStrokes.values())
  .sort((a, b) => a.sequence - b.sequence);

for (const stroke of strokes) {
  if (!stroke.isUndone) {
    this.drawStroke(ctx, stroke);
  }
}
```

Since sequence numbers are assigned by the server, all clients see the same order.

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Two users draw at same spot | Both strokes render (overlapping) |
| User disconnects mid-stroke | Server cancels their active stroke |
| Network delay | Stroke appears when server confirms |
| Undo during another's stroke | Undo only affects committed strokes |

---

## Performance Optimizations

### 1. Point Batching

Sending every mousemove would flood the network:

```javascript
// Batch every 3 points
if (this.currentStroke.points.length % 3 === 0) {
  this.onStrokeUpdate(id, this.currentStroke.points.slice(-3));
}
```

### 2. Cursor Throttling

Cursor updates are throttled to ~20fps:

```javascript
updateCursor(x, y) {
  const now = Date.now();
  if (now - this.lastCursorUpdate < 50) return;  // 50ms = 20fps
  this.lastCursorUpdate = now;
  this.socket.emit('cursor:update', { x, y });
}
```

### 3. Layered Rendering

Instead of clearing the entire canvas on every change:

| Event | Action | Performance |
|-------|--------|-------------|
| Drawing | Update active layer only | O(current stroke) |
| Commit | Draw to strokes layer, clear active | O(1) |
| Undo/Redo | Full re-render of strokes layer | O(n strokes) |

### 4. Device Pixel Ratio

Canvases are scaled for sharp rendering on Retina displays:

```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = width * dpr;
canvas.height = height * dpr;
ctx.scale(dpr, dpr);
```

### 5. Cursor Animation Frame

Remote cursors are rendered in a `requestAnimationFrame` loop, decoupled from WebSocket events:

```javascript
startCursorAnimation() {
  const animate = () => {
    this.renderCursors();
    requestAnimationFrame(animate);
  };
  animate();
}
```

---

## Scaling Considerations

### Current Limits

| Metric | Practical Limit | Bottleneck |
|--------|----------------|------------|
| Users per room | ~50 | Cursor broadcast bandwidth |
| Strokes per room | ~10,000 | Client-side re-render |
| Rooms per server | ~100 | Server memory |

### Scaling Strategies

#### 1. Horizontal Socket.io Scaling

Use Redis adapter for multi-server Socket.io:

```javascript
const { createAdapter } = require('@socket.io/redis-adapter');
io.adapter(createAdapter(pubClient, subClient));
```

#### 2. Stroke Batching/Decimation

For very long strokes, reduce point density:

```javascript
if (stroke.points.length > 1000) {
  stroke.points = decimatePoints(stroke.points, 500);
}
```

#### 3. Viewport Culling

For large canvases, only render strokes in the visible viewport.

#### 4. Persistence Layer

Add Redis/MongoDB for state persistence:

```javascript
// On stroke commit
await redis.lpush(`room:${roomId}:strokes`, JSON.stringify(stroke));

// On room join
const strokes = await redis.lrange(`room:${roomId}:strokes`, 0, -1);
```

#### 5. Cursor Spatial Hashing

For 100+ users, only broadcast cursors to nearby users:

```javascript
const nearbyUsers = getUsersInRadius(cursor.x, cursor.y, 500);
nearbyUsers.forEach(u => u.socket.emit('cursor:broadcast', data));
```

---

## Summary

This architecture prioritizes:

1. **Correctness**: Server-authoritative, immutable operations
2. **Consistency**: All clients converge to identical state
3. **Real-time UX**: Immediate feedback, smooth rendering
4. **Simplicity**: Linear history, no conflict resolution

The trade-offs:

- No offline support (requires connection)
- Memory grows with stroke count
- Full re-render on undo/redo

These are acceptable for the collaborative drawing use case where real-time consistency is paramount.
