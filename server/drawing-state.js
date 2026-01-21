/**
 * DrawingState - Server-side state management for a single room
 * 
 * ARCHITECTURAL DECISIONS:
 * 1. Immutable Operations: Strokes are never modified after creation, only flagged
 * 2. Server-Authoritative: All sequence numbers generated here, clients never set them
 * 3. Operation Log: Linear history enables deterministic undo/redo
 * 4. Separate Active Strokes: In-progress strokes are ephemeral until committed
 */

const { v4: uuidv4 } = require('uuid');

class DrawingState {
    constructor(roomId) {
        this.roomId = roomId;
        
        // The canonical operation log - ordered list of all committed strokes
        // Each stroke is immutable once committed
        this.operationLog = [];
        
        // Active strokes being drawn (ephemeral, not yet committed)
        // Key: strokeId, Value: stroke object
        this.activeStrokes = new Map();
        
        // Stack of stroke IDs that have been undone (for redo)
        // Cleared when any new stroke is committed
        this.redoStack = [];
        
        // Monotonically increasing sequence number
        // This is the ONLY source of ordering truth
        this.sequenceCounter = 0;
        
        // Timestamp of last activity (for room cleanup)
        this.lastActivity = Date.now();
    }

    /**
     * Generate the next sequence number
     * Called ONLY when committing a stroke
     */
    nextSequence() {
        return ++this.sequenceCounter;
    }

    /**
     * Start a new stroke (ephemeral phase)
     * The stroke is NOT yet part of the operation log
     * 
     * @param {Object} strokeData - Initial stroke data from client
     * @param {string} userId - User who initiated the stroke
     * @returns {Object} The created active stroke
     */
    startStroke(strokeData, userId) {
        const stroke = {
            id: strokeData.id || uuidv4(),
            odriginal: strokeData.id,
            userId: userId,
            tool: strokeData.tool || 'brush',
            color: strokeData.color || '#000000',
            width: strokeData.width || 3,
            points: strokeData.point ? [strokeData.point] : [],
            timestamp: Date.now(),
            sequence: null, // Not assigned until commit
            isUndone: false
        };

        this.activeStrokes.set(stroke.id, stroke);
        this.lastActivity = Date.now();
        
        return stroke;
    }

    /**
     * Update an active stroke with new points
     * Points are batched by the client for efficiency
     * 
     * @param {string} strokeId - ID of the stroke to update
     * @param {Array} points - Array of new points to add
     * @returns {Object|null} The updated stroke, or null if not found
     */
    updateStroke(strokeId, points) {
        const stroke = this.activeStrokes.get(strokeId);
        if (!stroke) {
            return null;
        }

        // Append new points to the stroke
        if (Array.isArray(points)) {
            stroke.points.push(...points);
        }
        
        this.lastActivity = Date.now();
        return stroke;
    }

    /**
     * End and commit an active stroke
     * 
     * CRITICAL: This is the transition from ephemeral to permanent
     * - Assigns server sequence number
     * - Moves to operation log
     * - CLEARS THE REDO STACK (redo invalidation)
     * 
     * @param {string} strokeId - ID of the stroke to finalize
     * @returns {Object|null} The committed stroke with sequence number
     */
    endStroke(strokeId) {
        const stroke = this.activeStrokes.get(strokeId);
        if (!stroke) {
            return null;
        }

        // Assign the authoritative sequence number
        stroke.sequence = this.nextSequence();
        stroke.timestamp = Date.now();

        // Move from active to committed
        this.operationLog.push(stroke);
        this.activeStrokes.delete(strokeId);

        // CRITICAL: Any new operation invalidates the redo stack
        // This prevents branching history
        this.redoStack = [];
        
        this.lastActivity = Date.now();
        return stroke;
    }

    /**
     * Cancel an active stroke (e.g., user disconnected mid-stroke)
     * 
     * @param {string} strokeId - ID of the stroke to cancel
     * @returns {boolean} True if stroke was cancelled
     */
    cancelStroke(strokeId) {
        return this.activeStrokes.delete(strokeId);
    }

    /**
     * Cancel all strokes by a specific user
     * Called when user disconnects
     * 
     * @param {string} userId - User whose strokes to cancel
     * @returns {Array} List of cancelled stroke IDs
     */
    cancelUserStrokes(userId) {
        const cancelled = [];
        for (const [strokeId, stroke] of this.activeStrokes) {
            if (stroke.userId === userId) {
                this.activeStrokes.delete(strokeId);
                cancelled.push(strokeId);
            }
        }
        return cancelled;
    }

    /**
     * GLOBAL UNDO
     * 
     * Algorithm:
     * 1. Scan operationLog from END to START
     * 2. Find the FIRST stroke where isUndone === false
     * 3. Mark it as isUndone = true
     * 4. Push its ID to redoStack
     * 
     * This ensures we always undo the most recent visible operation,
     * regardless of which user created it.
     * 
     * @returns {Object|null} The undone stroke, or null if nothing to undo
     */
    undo() {
        // Find last non-undone stroke (reverse iteration)
        for (let i = this.operationLog.length - 1; i >= 0; i--) {
            const stroke = this.operationLog[i];
            if (!stroke.isUndone) {
                // Mark as undone
                stroke.isUndone = true;
                // Push to redo stack
                this.redoStack.push(stroke.id);
                this.lastActivity = Date.now();
                return stroke;
            }
        }
        return null; // Nothing to undo
    }

    /**
     * GLOBAL REDO
     * 
     * Algorithm:
     * 1. Pop the last ID from redoStack
     * 2. Find the corresponding stroke
     * 3. Mark it as isUndone = false
     * 
     * @returns {Object|null} The redone stroke, or null if nothing to redo
     */
    redo() {
        if (this.redoStack.length === 0) {
            return null;
        }

        const strokeId = this.redoStack.pop();
        const stroke = this.operationLog.find(s => s.id === strokeId);
        
        if (stroke) {
            stroke.isUndone = false;
            this.lastActivity = Date.now();
            return stroke;
        }
        
        return null;
    }

    /**
     * Get all VISIBLE strokes (not undone)
     * Used for initial state sync and re-rendering
     * 
     * @returns {Array} Ordered list of visible strokes
     */
    getVisibleStrokes() {
        return this.operationLog.filter(stroke => !stroke.isUndone);
    }

    /**
     * Get the full state for syncing to a new client
     * 
     * Includes:
     * - All strokes (including undone, for undo visualization)
     * - Current active strokes (other users drawing)
     * - Redo stack size (for UI state)
     * 
     * @returns {Object} Complete room state
     */
    getFullState() {
        return {
            operationLog: this.operationLog.map(stroke => ({
                ...stroke,
                // Ensure we're sending a clean copy
            })),
            activeStrokes: Array.from(this.activeStrokes.values()),
            canUndo: this.operationLog.some(s => !s.isUndone),
            canRedo: this.redoStack.length > 0,
            sequenceCounter: this.sequenceCounter
        };
    }

    /**
     * Get the current undo/redo capability state
     * 
     * @returns {Object} { canUndo, canRedo }
     */
    getUndoRedoState() {
        return {
            canUndo: this.operationLog.some(s => !s.isUndone),
            canRedo: this.redoStack.length > 0
        };
    }

    /**
     * Clear all state (for room reset)
     */
    clear() {
        this.operationLog = [];
        this.activeStrokes.clear();
        this.redoStack = [];
        this.sequenceCounter = 0;
        this.lastActivity = Date.now();
    }
}

module.exports = DrawingState;
