# 🎨 Collaborative Canvas

A **real-time collaborative drawing application** where multiple users can draw together on a shared canvas with live synchronization, cursor presence, and per-user undo/redo functionality.

**Developer:** Abhishek Kumar

---

## ✨ Features

### 🖌️ Drawing Tools
- **Brush Tool** - Smooth freehand drawing with quadratic Bezier curves
- **Eraser Tool** - Non-destructive erasing (stroke-based)
- **Color Picker** - Full color palette with quick-select colors
- **Stroke Width** - Adjustable from 1-50px with live preview

### 🌐 Real-Time Collaboration
- **Live Drawing Sync** - See strokes as they're being drawn by others
- **Cursor Presence** - View other users' cursors with name labels
- **User Awareness** - Join/leave notifications and online user count
- **Room-Based** - Multiple independent canvas rooms

### ↩️ Per-User Undo/Redo
- Each user can **only undo/redo their own strokes**
- No user can affect another user's work
- Consistent state across all clients

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | HTML5 Canvas API, Vanilla JavaScript |
| **Backend** | Node.js, Express.js |
| **Real-Time** | Socket.io |
| **Architecture** | Server-Authoritative, Event-Driven |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ installed
- npm

### Installation

```bash
# Navigate to project directory
cd collaborative-canvas

# Install dependencies
npm install

# Start the server
npm start
```

### Access the Application
Open your browser and go to: `http://localhost:3000`

---

## 📖 How to Use

1. **Join a Room** - Enter room name and your display name
2. **Select Tool** - Choose Brush (B) or Eraser (E)
3. **Pick Color** - Click color picker or quick-select buttons
4. **Adjust Width** - Use slider or `[` `]` keys
5. **Draw** - Click and drag on canvas
6. **Undo/Redo** - Use `Ctrl+Z` / `Ctrl+Y` (only affects your strokes)

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `B` | Brush tool |
| `E` | Eraser tool |
| `Ctrl + Z` | Undo your last stroke |
| `Ctrl + Y` | Redo your last stroke |
| `[` | Decrease stroke width |
| `]` | Increase stroke width |

---

## 📁 Project Structure

```
collaborative-canvas/
├── client/
│   ├── index.html       # Main HTML with layered canvases
│   ├── style.css        # Dark theme styling
│   ├── canvas.js        # Drawing engine & canvas logic
│   ├── websocket.js     # Socket.io client wrapper
│   └── main.js          # Application orchestration
├── server/
│   ├── server.js        # Express + Socket.io server
│   ├── rooms.js         # Room management
│   └── drawing-state.js # Drawing state & per-user undo/redo
├── package.json
├── README.md
└── ARCHITECTURE.md      # Detailed architecture documentation
```

---

## 🔌 WebSocket Events

### Client → Server
| Event | Description |
|-------|-------------|
| `room:join` | Join a drawing room |
| `stroke:start` | Begin a new stroke |
| `stroke:update` | Add points to stroke |
| `stroke:end` | Finalize stroke |
| `cursor:update` | Update cursor position |
| `undo` | Undo user's last stroke |
| `redo` | Redo user's last stroke |

### Server → Clients
| Event | Description |
|-------|-------------|
| `stroke:preview` | Broadcast in-progress stroke |
| `stroke:commit` | Broadcast finalized stroke |
| `cursor:broadcast` | Broadcast cursor position |
| `undo` / `redo` | Broadcast undo/redo events |
| `user:join` / `user:leave` | User presence updates |

---

## 🎯 Key Design Decisions

1. **Server-Authoritative** - All state changes validated by server
2. **Per-User Undo/Redo** - Each user has isolated undo/redo history
3. **Immutable Strokes** - Strokes are never modified after creation
4. **Layered Canvas** - Separate layers for strokes, previews, and cursors
5. **Smooth Rendering** - Quadratic Bezier curves for smooth lines

---

## 🧪 Testing Multi-User

1. Open `http://localhost:3000` in multiple browser tabs
2. Join the same room in each tab
3. Draw in one tab - watch it appear in others
4. Try undo - only your own strokes will be undone!

**Cross-Device Testing:**
```
http://<your-ip>:3000
```

---

## 📄 License

MIT License

---

## 👨‍💻 Developer

**Abhishek Kumar**

Built with ❤️ using Node.js and Socket.io