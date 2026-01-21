/**
 * RoomManager - Manages room lifecycle and user presence
 * 
 * ARCHITECTURAL DECISIONS:
 * 1. Room Isolation: Each room has independent state
 * 2. User Tracking: Name + color assigned on join
 * 3. Cursor Presence: Real-time cursor positions for awareness
 * 4. Cleanup: Rooms can be purged after inactivity
 */

const DrawingState = require('./drawing-state');

// Predefined color palette for user assignment
// High contrast colors for visibility
const USER_COLORS = [
    '#FF6B6B', // Red
    '#4ECDC4', // Teal
    '#45B7D1', // Sky Blue
    '#96CEB4', // Sage
    '#FFEAA7', // Yellow
    '#DDA0DD', // Plum
    '#98D8C8', // Mint
    '#F7DC6F', // Gold
    '#BB8FCE', // Lavender
    '#85C1E9', // Light Blue
    '#F8B500', // Amber
    '#00CED1', // Dark Cyan
    '#FF7F50', // Coral
    '#90EE90', // Light Green
    '#FFB6C1', // Light Pink
];

// Default names for anonymous users
const DEFAULT_NAMES = [
    'Artist', 'Painter', 'Sketcher', 'Creator', 'Designer',
    'Doodler', 'Illustrator', 'Drawer', 'Architect', 'Maker'
];

class Room {
    constructor(roomId) {
        this.id = roomId;
        this.drawingState = new DrawingState(roomId);
        this.users = new Map(); // socketId -> user info
        this.colorIndex = 0;
        this.createdAt = Date.now();
    }

    /**
     * Add a user to the room
     * Assigns unique color and generates name if not provided
     * 
     * @param {string} socketId - Socket ID of the user
     * @param {string} userName - Optional user name
     * @returns {Object} User info
     */
    addUser(socketId, userName) {
        // Assign color from palette (cycles through)
        const color = USER_COLORS[this.colorIndex % USER_COLORS.length];
        this.colorIndex++;

        // Generate name if not provided
        const name = userName ||
            `${DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)]} ${this.users.size + 1}`;

        const user = {
            id: socketId,
            name: name,
            color: color,
            cursor: null, // { x, y } when tracking
            isDrawing: false,
            joinedAt: Date.now()
        };

        this.users.set(socketId, user);
        return user;
    }

    /**
     * Remove a user from the room
     * Also cancels any active strokes by this user
     * 
     * @param {string} socketId - Socket ID of the user
     * @returns {Object|null} Removed user info
     */
    removeUser(socketId) {
        const user = this.users.get(socketId);
        if (user) {
            // Cancel any in-progress strokes
            this.drawingState.cancelUserStrokes(socketId);
            this.users.delete(socketId);
        }
        return user;
    }

    /**
     * Get user by socket ID
     * 
     * @param {string} socketId 
     * @returns {Object|null}
     */
    getUser(socketId) {
        return this.users.get(socketId);
    }

    /**
     * Update user cursor position
     * 
     * @param {string} socketId 
     * @param {number} x 
     * @param {number} y 
     */
    updateCursor(socketId, x, y) {
        const user = this.users.get(socketId);
        if (user) {
            user.cursor = { x, y };
        }
    }

    /**
     * Set user drawing state
     * 
     * @param {string} socketId 
     * @param {boolean} isDrawing 
     */
    setDrawing(socketId, isDrawing) {
        const user = this.users.get(socketId);
        if (user) {
            user.isDrawing = isDrawing;
        }
    }

    /**
     * Get all users in the room
     * 
     * @returns {Array} List of user objects
     */
    getUsers() {
        return Array.from(this.users.values());
    }

    /**
     * Get all users except one (for broadcasting)
     * 
     * @param {string} excludeSocketId 
     * @returns {Array}
     */
    getOtherUsers(excludeSocketId) {
        return this.getUsers().filter(u => u.id !== excludeSocketId);
    }

    /**
     * Check if room is empty
     * 
     * @returns {boolean}
     */
    isEmpty() {
        return this.users.size === 0;
    }

    /**
     * Get room state for syncing to new user
     * 
     * @returns {Object}
     */
    getState() {
        return {
            roomId: this.id,
            users: this.getUsers().map(u => ({
                id: u.id,
                name: u.name,
                color: u.color,
                cursor: u.cursor,
                isDrawing: u.isDrawing
            })),
            drawing: this.drawingState.getFullState()
        };
    }
}

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> Room

        // Cleanup interval for inactive rooms (every 5 minutes)
        this.cleanupInterval = setInterval(() => this.cleanupInactiveRooms(), 5 * 60 * 1000);
    }

    /**
     * Get or create a room
     * 
     * @param {string} roomId 
     * @returns {Room}
     */
    getOrCreateRoom(roomId) {
        if (!this.rooms.has(roomId)) {
            console.log(`[RoomManager] Creating new room: ${roomId}`);
            this.rooms.set(roomId, new Room(roomId));
        }
        return this.rooms.get(roomId);
    }

    /**
     * Get an existing room
     * 
     * @param {string} roomId 
     * @returns {Room|null}
     */
    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    /**
     * Remove a room if it's empty
     * 
     * @param {string} roomId 
     * @returns {boolean} True if room was removed
     */
    removeRoomIfEmpty(roomId) {
        const room = this.rooms.get(roomId);
        if (room && room.isEmpty()) {
            console.log(`[RoomManager] Removing empty room: ${roomId}`);
            this.rooms.delete(roomId);
            return true;
        }
        return false;
    }

    /**
     * Cleanup rooms that have been inactive for too long
     * Currently set to 1 hour
     */
    cleanupInactiveRooms() {
        const ONE_HOUR = 60 * 60 * 1000;
        const now = Date.now();

        for (const [roomId, room] of this.rooms) {
            if (room.isEmpty() && (now - room.drawingState.lastActivity) > ONE_HOUR) {
                console.log(`[RoomManager] Cleaning up inactive room: ${roomId}`);
                this.rooms.delete(roomId);
            }
        }
    }

    /**
     * Get statistics about all rooms
     * 
     * @returns {Object}
     */
    getStats() {
        let totalUsers = 0;
        let totalStrokes = 0;

        for (const room of this.rooms.values()) {
            totalUsers += room.users.size;
            totalStrokes += room.drawingState.operationLog.length;
        }

        return {
            roomCount: this.rooms.size,
            totalUsers,
            totalStrokes
        };
    }

    /**
     * Cleanup on server shutdown
     */
    shutdown() {
        clearInterval(this.cleanupInterval);
        this.rooms.clear();
    }
}

// Export singleton instance
module.exports = new RoomManager();
