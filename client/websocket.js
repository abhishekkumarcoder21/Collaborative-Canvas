/**
 * WebSocketClient - Socket.io client wrapper for collaborative canvas
 * 
 * Handles all real-time communication with the server
 * Provides clean event-based API for the main application
 * 
 * PROTOCOL:
 * - Client → Server: stroke:start, stroke:update, stroke:end, cursor:update, undo, redo
 * - Server → Clients: stroke:preview, stroke:commit, cursor:broadcast, undo, redo, user:join, user:leave, room:state
 */

class WebSocketClient {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.currentRoom = null;
        this.currentUser = null;

        // Event callbacks
        this.callbacks = {
            onConnect: null,
            onDisconnect: null,
            onRoomJoined: null,
            onStrokePreview: null,
            onStrokeCommit: null,
            onStrokeCancel: null,
            onCursorUpdate: null,
            onUndo: null,
            onRedo: null,
            onUserJoin: null,
            onUserLeave: null,
            onCanvasClear: null,
            onError: null,
            onUndoRedoState: null
        };

        // Cursor throttling
        this.lastCursorUpdate = 0;
        this.cursorThrottleMs = 50; // ~20fps
    }

    /**
     * Connect to the server
     */
    connect() {
        return new Promise((resolve, reject) => {
            // Get Socket.io URL (same as page origin)
            const socketUrl = window.location.origin;

            this.socket = io(socketUrl, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000
            });

            // Connection events
            this.socket.on('connect', () => {
                console.log('[WebSocket] Connected:', this.socket.id);
                this.connected = true;

                // If we were in a room, rejoin
                if (this.currentRoom) {
                    this.joinRoom(this.currentRoom, this.currentUser?.name);
                }

                if (this.callbacks.onConnect) {
                    this.callbacks.onConnect();
                }
                resolve();
            });

            this.socket.on('disconnect', (reason) => {
                console.log('[WebSocket] Disconnected:', reason);
                this.connected = false;

                if (this.callbacks.onDisconnect) {
                    this.callbacks.onDisconnect(reason);
                }
            });

            this.socket.on('connect_error', (error) => {
                console.error('[WebSocket] Connection error:', error);
                if (this.callbacks.onError) {
                    this.callbacks.onError(error);
                }
                reject(error);
            });

            // Server events
            this.setupEventListeners();
        });
    }

    /**
     * Set up all server event listeners
     */
    setupEventListeners() {
        // Stroke preview (other users drawing)
        this.socket.on('stroke:preview', (data) => {
            if (this.callbacks.onStrokePreview) {
                this.callbacks.onStrokePreview(data);
            }
        });

        // Stroke commit (finalized stroke from server)
        this.socket.on('stroke:commit', (data) => {
            if (this.callbacks.onStrokeCommit) {
                this.callbacks.onStrokeCommit(data.stroke);
            }
            if (data.undoRedoState && this.callbacks.onUndoRedoState) {
                this.callbacks.onUndoRedoState(data.undoRedoState);
            }
        });

        // Stroke cancellation
        this.socket.on('stroke:cancel', (data) => {
            if (this.callbacks.onStrokeCancel) {
                this.callbacks.onStrokeCancel(data.strokeId);
            }
        });

        // Cursor broadcast (other users' cursors)
        this.socket.on('cursor:broadcast', (data) => {
            if (this.callbacks.onCursorUpdate) {
                this.callbacks.onCursorUpdate(data);
            }
        });

        // Global undo
        this.socket.on('undo', (data) => {
            if (this.callbacks.onUndo) {
                this.callbacks.onUndo(data.strokeId, data.userName);
            }
            if (data.undoRedoState && this.callbacks.onUndoRedoState) {
                this.callbacks.onUndoRedoState(data.undoRedoState);
            }
        });

        // Global redo
        this.socket.on('redo', (data) => {
            if (this.callbacks.onRedo) {
                this.callbacks.onRedo(data.strokeId, data.userName);
            }
            if (data.undoRedoState && this.callbacks.onUndoRedoState) {
                this.callbacks.onUndoRedoState(data.undoRedoState);
            }
        });

        // User join
        this.socket.on('user:join', (data) => {
            if (this.callbacks.onUserJoin) {
                this.callbacks.onUserJoin(data.user);
            }
        });

        // User leave
        this.socket.on('user:leave', (data) => {
            if (this.callbacks.onUserLeave) {
                this.callbacks.onUserLeave(data.userId, data.userName);
            }
        });

        // Canvas clear
        this.socket.on('canvas:clear', (data) => {
            if (this.callbacks.onCanvasClear) {
                this.callbacks.onCanvasClear(data.userName);
            }
        });
    }

    /**
     * Join a room
     */
    joinRoom(roomId, userName) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                reject(new Error('Not connected'));
                return;
            }

            this.socket.emit('room:join', { roomId, userName }, (response) => {
                if (response.error) {
                    reject(new Error(response.error));
                    return;
                }

                this.currentRoom = roomId;
                this.currentUser = response.user;

                console.log('[WebSocket] Joined room:', roomId, 'as', response.user.name);

                if (this.callbacks.onRoomJoined) {
                    this.callbacks.onRoomJoined(response.user, response.state);
                }

                resolve(response);
            });
        });
    }

    /**
     * Leave current room
     */
    leaveRoom() {
        if (this.socket && this.connected) {
            this.socket.emit('room:leave');
            this.currentRoom = null;
        }
    }

    /**
     * Start a new stroke
     */
    startStroke(stroke) {
        if (!this.socket || !this.connected) return;

        this.socket.emit('stroke:start', {
            id: stroke.id,
            tool: stroke.tool,
            color: stroke.color,
            width: stroke.width,
            point: stroke.points[0]
        });
    }

    /**
     * Update stroke with new points
     */
    updateStroke(strokeId, points) {
        if (!this.socket || !this.connected) return;

        this.socket.emit('stroke:update', {
            id: strokeId,
            points: points
        });
    }

    /**
     * End a stroke
     */
    endStroke(strokeId) {
        if (!this.socket || !this.connected) return;

        this.socket.emit('stroke:end', {
            id: strokeId
        });
    }

    /**
     * Update cursor position (throttled)
     */
    updateCursor(x, y) {
        if (!this.socket || !this.connected) return;

        const now = Date.now();
        if (now - this.lastCursorUpdate < this.cursorThrottleMs) {
            return;
        }
        this.lastCursorUpdate = now;

        this.socket.emit('cursor:update', { x, y });
    }

    /**
     * Request global undo
     */
    undo() {
        if (!this.socket || !this.connected) return;
        this.socket.emit('undo');
    }

    /**
     * Request global redo
     */
    redo() {
        if (!this.socket || !this.connected) return;
        this.socket.emit('redo');
    }

    /**
     * Clear canvas
     */
    clearCanvas() {
        if (!this.socket || !this.connected) return;
        this.socket.emit('canvas:clear');
    }

    /**
     * Set callback for an event
     */
    on(event, callback) {
        const callbackName = 'on' + event.charAt(0).toUpperCase() + event.slice(1);
        if (callbackName in this.callbacks) {
            this.callbacks[callbackName] = callback;
        }
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.connected = false;
    }

    /**
     * Check if connected
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Get current user info
     */
    getUser() {
        return this.currentUser;
    }

    /**
     * Get current room
     */
    getRoom() {
        return this.currentRoom;
    }
}

// Export for use in main.js
window.WebSocketClient = WebSocketClient;
