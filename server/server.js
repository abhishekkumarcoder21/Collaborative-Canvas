/**
 * Server - Express + Socket.io server for collaborative canvas
 * 
 * ARCHITECTURAL DECISIONS:
 * 1. Server-Authoritative: All state changes go through server
 * 2. Room-Scoped Broadcasting: Events only go to users in same room
 * 3. Sequence Numbers: Only assigned on stroke commit
 * 4. Preview vs Commit: Active strokes are broadcast as previews
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const roomManager = require('./rooms');

// Configuration
const PORT = process.env.PORT || 3000;

// Create Express app
const app = express();
const httpServer = createServer(app);

// Create Socket.io server with CORS for development
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    // Performance tuning
    pingTimeout: 60000,
    pingInterval: 25000
});

// Serve static files from client directory
app.use(express.static(path.join(__dirname, '../client')));

// Health check endpoint
app.get('/health', (req, res) => {
    const stats = roomManager.getStats();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        ...stats
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Track which room this socket is in
    let currentRoom = null;
    let currentUser = null;

    /**
     * JOIN ROOM
     * 
     * Client sends: { roomId: string, userName?: string }
     * Server responds with full room state
     * Server broadcasts user:join to other clients
     */
    socket.on('room:join', (data, callback) => {
        const { roomId, userName } = data;

        if (!roomId) {
            if (callback) callback({ error: 'Room ID required' });
            return;
        }

        // Leave previous room if any
        if (currentRoom) {
            leaveCurrentRoom();
        }

        // Join new room
        const room = roomManager.getOrCreateRoom(roomId);
        currentUser = room.addUser(socket.id, userName);
        currentRoom = room;

        // Join Socket.io room for broadcasting
        socket.join(roomId);

        console.log(`[Socket] ${currentUser.name} joined room: ${roomId}`);

        // Send full state to joining client
        const roomState = room.getState();

        if (callback) {
            callback({
                success: true,
                user: currentUser,
                state: roomState
            });
        }

        // Broadcast to others that user joined
        socket.to(roomId).emit('user:join', {
            user: {
                id: currentUser.id,
                name: currentUser.name,
                color: currentUser.color
            }
        });
    });

    /**
     * LEAVE ROOM
     * 
     * Explicit room leave (also called on disconnect)
     */
    socket.on('room:leave', () => {
        leaveCurrentRoom();
    });

    /**
     * STROKE:START
     * 
     * Client begins a new stroke
     * Server creates ephemeral active stroke
     * Broadcasts preview to other clients
     */
    socket.on('stroke:start', (data) => {
        if (!currentRoom || !currentUser) return;

        const stroke = currentRoom.drawingState.startStroke(data, socket.id);
        currentRoom.setDrawing(socket.id, true);

        // Broadcast preview to others
        socket.to(currentRoom.id).emit('stroke:preview', {
            type: 'start',
            stroke: {
                id: stroke.id,
                userId: stroke.userId,
                userName: currentUser.name,
                userColor: currentUser.color,
                tool: stroke.tool,
                color: stroke.color,
                width: stroke.width,
                points: stroke.points
            }
        });
    });

    /**
     * STROKE:UPDATE
     * 
     * Client sends batched points during drawing
     * Server updates active stroke
     * Broadcasts point updates to other clients
     */
    socket.on('stroke:update', (data) => {
        if (!currentRoom || !currentUser) return;

        const { id, points } = data;
        const stroke = currentRoom.drawingState.updateStroke(id, points);

        if (stroke) {
            // Broadcast point updates to others
            socket.to(currentRoom.id).emit('stroke:preview', {
                type: 'update',
                strokeId: id,
                points: points
            });
        }
    });

    /**
     * STROKE:END
     * 
     * Client completes a stroke
     * Server commits the stroke with sequence number
     * Broadcasts committed stroke to ALL clients (including sender)
     * 
     * IMPORTANT: The committed stroke replaces any preview
     */
    socket.on('stroke:end', (data) => {
        if (!currentRoom || !currentUser) return;

        const { id } = data;
        const committedStroke = currentRoom.drawingState.endStroke(id);
        currentRoom.setDrawing(socket.id, false);

        if (committedStroke) {
            // Broadcast committed stroke to ALL clients in room
            // This is the authoritative version that replaces previews
            io.to(currentRoom.id).emit('stroke:commit', {
                stroke: {
                    ...committedStroke,
                    userName: currentUser.name,
                    userColor: currentUser.color
                },
                undoRedoState: currentRoom.drawingState.getUndoRedoState(socket.id)
            });

            console.log(`[Stroke] Committed stroke ${id} with sequence ${committedStroke.sequence}`);
        }
    });

    /**
     * STROKE:CANCEL
     * 
     * Client cancels an in-progress stroke
     */
    socket.on('stroke:cancel', (data) => {
        if (!currentRoom) return;

        const { id } = data;
        currentRoom.drawingState.cancelStroke(id);
        currentRoom.setDrawing(socket.id, false);

        // Broadcast cancellation
        socket.to(currentRoom.id).emit('stroke:cancel', { strokeId: id });
    });

    /**
     * CURSOR:UPDATE
     * 
     * Client sends cursor position
     * Throttled on client side (~20fps)
     * Broadcasts to other clients
     */
    socket.on('cursor:update', (data) => {
        if (!currentRoom || !currentUser) return;

        const { x, y } = data;
        currentRoom.updateCursor(socket.id, x, y);

        // Broadcast to others
        socket.to(currentRoom.id).emit('cursor:broadcast', {
            userId: socket.id,
            name: currentUser.name,
            color: currentUser.color,
            x,
            y,
            isDrawing: currentUser.isDrawing
        });
    });

    /**
     * UNDO
     * 
     * PER-USER UNDO - each user can only undo their own strokes
     * Server finds and marks last non-undone stroke BY THIS USER
     * Broadcasts to ALL clients
     */
    socket.on('undo', () => {
        if (!currentRoom || !currentUser) return;

        const undoneStroke = currentRoom.drawingState.undo(socket.id);

        if (undoneStroke) {
            // Broadcast undo to ALL clients (everyone sees the visual change)
            io.to(currentRoom.id).emit('undo', {
                strokeId: undoneStroke.id,
                odriginalUserId: undoneStroke.userId,
                requestedBy: socket.id,
                userName: currentUser.name
            });

            // Send per-user undo/redo state to only the requesting user
            socket.emit('undoRedoState', currentRoom.drawingState.getUndoRedoState(socket.id));

            console.log(`[Undo] ${currentUser.name} undid their stroke ${undoneStroke.id}`);
        }
    });

    /**
     * REDO
     * 
     * PER-USER REDO - each user can only redo their own strokes
     * Server pops from this user's redo stack and restores stroke
     * Broadcasts to ALL clients
     */
    socket.on('redo', () => {
        if (!currentRoom || !currentUser) return;

        const redoneStroke = currentRoom.drawingState.redo(socket.id);

        if (redoneStroke) {
            // Broadcast redo to ALL clients (everyone sees the visual change)
            io.to(currentRoom.id).emit('redo', {
                strokeId: redoneStroke.id,
                odriginalUserId: redoneStroke.userId,
                requestedBy: socket.id,
                userName: currentUser.name
            });

            // Send per-user undo/redo state to only the requesting user
            socket.emit('undoRedoState', currentRoom.drawingState.getUndoRedoState(socket.id));

            console.log(`[Redo] ${currentUser.name} redid their stroke ${redoneStroke.id}`);
        }
    });

    /**
     * CLEAR CANVAS
     * 
     * Clears all strokes (requires confirmation)
     */
    socket.on('canvas:clear', () => {
        if (!currentRoom || !currentUser) return;

        currentRoom.drawingState.clear();

        // Broadcast clear to ALL clients
        io.to(currentRoom.id).emit('canvas:clear', {
            userId: socket.id,
            userName: currentUser.name
        });

        console.log(`[Clear] ${currentUser.name} cleared the canvas`);
    });

    /**
     * DISCONNECT
     * 
     * Clean up user from room
     * Cancel any active strokes
     * Broadcast user leave
     */
    socket.on('disconnect', (reason) => {
        console.log(`[Socket] Client disconnected: ${socket.id} (${reason})`);
        leaveCurrentRoom();
    });

    /**
     * Helper: Leave current room
     */
    function leaveCurrentRoom() {
        if (!currentRoom || !currentUser) return;

        const roomId = currentRoom.id;
        const userName = currentUser.name;

        // Remove user from room
        currentRoom.removeUser(socket.id);
        socket.leave(roomId);

        // Broadcast user leave
        socket.to(roomId).emit('user:leave', {
            userId: socket.id,
            userName: userName
        });

        console.log(`[Socket] ${userName} left room: ${roomId}`);

        // Clean up empty rooms after a delay
        setTimeout(() => {
            roomManager.removeRoomIfEmpty(roomId);
        }, 5000);

        currentRoom = null;
        currentUser = null;
    }
});

// Start server
httpServer.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🎨 Collaborative Canvas Server                              ║
║                                                               ║
║   Server running at: http://localhost:${PORT}                   ║
║                                                               ║
║   Open multiple browser tabs to test collaboration            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    roomManager.shutdown();
    httpServer.close(() => {
        console.log('[Server] Goodbye!');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n[Server] Shutting down...');
    roomManager.shutdown();
    httpServer.close(() => {
        process.exit(0);
    });
});
