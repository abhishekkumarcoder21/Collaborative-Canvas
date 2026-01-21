/**
 * DrawingCanvas - Multi-layer canvas drawing engine
 * 
 * ARCHITECTURE:
 * - Layer 1 (background): Static white background
 * - Layer 2 (strokes): All committed strokes, cached for performance
 * - Layer 3 (active): In-progress strokes (ephemeral previews)
 * - Layer 4 (cursors): Other users' cursor indicators
 * 
 * RENDERING STRATEGY:
 * - Normal drawing: Only update active layer, never clear strokes layer
 * - Stroke commit: Draw to strokes layer, clear from active layer
 * - Undo/Redo: Full re-render of strokes layer from operation log
 * 
 * SMOOTH CURVES:
 * - Uses quadratic Bezier curves between points
 * - Midpoint interpolation for smooth joins
 */

class DrawingCanvas {
    constructor(containerElement) {
        this.container = containerElement;

        // Get canvas elements
        this.backgroundCanvas = document.getElementById('canvas-background');
        this.strokesCanvas = document.getElementById('canvas-strokes');
        this.activeCanvas = document.getElementById('canvas-active');
        this.cursorsCanvas = document.getElementById('canvas-cursors');

        // Get 2D contexts
        this.backgroundCtx = this.backgroundCanvas.getContext('2d');
        this.strokesCtx = this.strokesCanvas.getContext('2d');
        this.activeCtx = this.activeCanvas.getContext('2d');
        this.cursorsCtx = this.cursorsCanvas.getContext('2d');

        // Drawing state
        this.isDrawing = false;
        this.currentStroke = null;
        this.lastPoint = null;

        // Tool settings
        this.tool = 'brush';
        this.color = '#000000';
        this.width = 5;

        // Committed strokes (the source of truth from server)
        this.committedStrokes = new Map(); // id -> stroke

        // Active strokes from other users (ephemeral)
        this.activeStrokes = new Map(); // id -> stroke

        // Remote cursors
        this.remoteCursors = new Map(); // odriginal -> cursor data

        // Animation frame for cursor rendering
        this.cursorAnimationFrame = null;

        // Initialize
        this.setupCanvases();
        this.bindEvents();
        this.startCursorAnimation();
    }

    /**
     * Initialize canvas sizes to match container
     */
    setupCanvases() {
        this.resize();

        // Fill background with white
        this.backgroundCtx.fillStyle = '#ffffff';
        this.backgroundCtx.fillRect(0, 0, this.backgroundCanvas.width, this.backgroundCanvas.height);
    }

    /**
     * Resize all canvases to match container size
     * Preserves content by re-rendering from stroke data
     */
    resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        const width = rect.width;
        const height = rect.height;

        [this.backgroundCanvas, this.strokesCanvas, this.activeCanvas, this.cursorsCanvas].forEach(canvas => {
            // Set display size
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';

            // Set actual size in memory (accounting for DPR for sharpness)
            canvas.width = width * dpr;
            canvas.height = height * dpr;

            // Scale context to match DPR
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
        });

        // Redraw background
        this.backgroundCtx.fillStyle = '#ffffff';
        this.backgroundCtx.fillRect(0, 0, width, height);

        // Re-render all strokes
        this.renderAllStrokes();
    }

    /**
     * Bind mouse and touch events
     */
    bindEvents() {
        const canvas = this.activeCanvas;

        // Mouse events
        canvas.addEventListener('mousedown', this.handlePointerDown.bind(this));
        canvas.addEventListener('mousemove', this.handlePointerMove.bind(this));
        canvas.addEventListener('mouseup', this.handlePointerUp.bind(this));
        canvas.addEventListener('mouseleave', this.handlePointerUp.bind(this));

        // Touch events
        canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
        canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));
        canvas.addEventListener('touchcancel', this.handleTouchEnd.bind(this));

        // Window resize
        window.addEventListener('resize', () => {
            // Debounce resize
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => this.resize(), 100);
        });
    }

    /**
     * Get coordinates from mouse/touch event, accounting for canvas offset
     */
    getCoordinates(event) {
        const rect = this.activeCanvas.getBoundingClientRect();
        const clientX = event.clientX || (event.touches && event.touches[0]?.clientX);
        const clientY = event.clientY || (event.touches && event.touches[0]?.clientY);

        if (clientX === undefined || clientY === undefined) {
            return null;
        }

        return {
            x: clientX - rect.left,
            y: clientY - rect.top,
            t: Date.now()
        };
    }

    // ==========================================
    // Pointer Event Handlers
    // ==========================================

    handlePointerDown(event) {
        const point = this.getCoordinates(event);
        if (!point) return;

        this.isDrawing = true;
        this.startStroke(point);
    }

    handlePointerMove(event) {
        const point = this.getCoordinates(event);
        if (!point) return;

        // Emit cursor position regardless of drawing state
        if (this.onCursorMove) {
            this.onCursorMove(point.x, point.y);
        }

        if (this.isDrawing && this.currentStroke) {
            this.continueStroke(point);
        }
    }

    handlePointerUp(event) {
        if (this.isDrawing && this.currentStroke) {
            this.endStroke();
        }
        this.isDrawing = false;
    }

    handleTouchStart(event) {
        event.preventDefault();
        if (event.touches.length === 1) {
            const point = this.getCoordinates(event);
            if (point) {
                this.isDrawing = true;
                this.startStroke(point);
            }
        }
    }

    handleTouchMove(event) {
        event.preventDefault();
        if (event.touches.length === 1) {
            const point = this.getCoordinates(event);
            if (point) {
                if (this.onCursorMove) {
                    this.onCursorMove(point.x, point.y);
                }
                if (this.isDrawing && this.currentStroke) {
                    this.continueStroke(point);
                }
            }
        }
    }

    handleTouchEnd(event) {
        if (this.isDrawing && this.currentStroke) {
            this.endStroke();
        }
        this.isDrawing = false;
    }

    // ==========================================
    // Stroke Creation & Management
    // ==========================================

    /**
     * Start a new stroke
     */
    startStroke(point) {
        const strokeId = this.generateStrokeId();

        this.currentStroke = {
            id: strokeId,
            tool: this.tool,
            color: this.color,
            width: this.width,
            points: [point]
        };

        this.lastPoint = point;

        // Draw initial point
        this.drawPoint(this.activeCtx, point, this.tool, this.color, this.width);

        // Notify callback
        if (this.onStrokeStart) {
            this.onStrokeStart(this.currentStroke);
        }
    }

    /**
     * Continue current stroke with new point
     */
    continueStroke(point) {
        if (!this.currentStroke) return;

        this.currentStroke.points.push(point);

        // Draw line segment with smooth curve
        this.drawSegment(this.activeCtx, this.lastPoint, point,
            this.currentStroke.tool, this.currentStroke.color, this.currentStroke.width);

        this.lastPoint = point;

        // Batch points and notify (every 3 points for efficiency)
        if (this.currentStroke.points.length % 3 === 0 && this.onStrokeUpdate) {
            const newPoints = this.currentStroke.points.slice(-3);
            this.onStrokeUpdate(this.currentStroke.id, newPoints);
        }
    }

    /**
     * End current stroke
     */
    endStroke() {
        if (!this.currentStroke) return;

        // Send remaining points
        if (this.onStrokeUpdate && this.currentStroke.points.length % 3 !== 0) {
            const remaining = this.currentStroke.points.length % 3;
            const newPoints = this.currentStroke.points.slice(-remaining);
            this.onStrokeUpdate(this.currentStroke.id, newPoints);
        }

        // Notify end
        if (this.onStrokeEnd) {
            this.onStrokeEnd(this.currentStroke.id);
        }

        // Don't clear active canvas yet - wait for server commit
        this.currentStroke = null;
        this.lastPoint = null;
    }

    /**
     * Generate unique stroke ID
     */
    generateStrokeId() {
        return 'stroke_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // ==========================================
    // Drawing Primitives
    // ==========================================

    /**
     * Configure context for brush or eraser
     */
    configureContext(ctx, tool, color, width) {
        if (tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.fillStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
        }
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }

    /**
     * Draw a single point (for stroke start)
     */
    drawPoint(ctx, point, tool, color, width) {
        this.configureContext(ctx, tool, color, width);
        ctx.beginPath();
        ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw line segment between two points
     * Uses quadratic curve for smoothness
     */
    drawSegment(ctx, from, to, tool, color, width) {
        this.configureContext(ctx, tool, color, width);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
    }

    /**
     * Draw a complete stroke with smooth curves
     * Uses quadratic Bezier curves through midpoints
     */
    drawStroke(ctx, stroke) {
        if (!stroke.points || stroke.points.length === 0) return;

        this.configureContext(ctx, stroke.tool, stroke.color, stroke.width);

        const points = stroke.points;

        if (points.length === 1) {
            // Single point - draw a dot
            this.drawPoint(ctx, points[0], stroke.tool, stroke.color, stroke.width);
            return;
        }

        if (points.length === 2) {
            // Two points - draw a line
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
            ctx.stroke();
            return;
        }

        // Multiple points - use quadratic curves for smoothness
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);

        // Draw curves through midpoints
        for (let i = 1; i < points.length - 1; i++) {
            const midX = (points[i].x + points[i + 1].x) / 2;
            const midY = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }

        // Connect to last point
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);

        ctx.stroke();

        // Reset composite operation
        ctx.globalCompositeOperation = 'source-over';
    }

    // ==========================================
    // State Management (from server)
    // ==========================================

    /**
     * Initialize state from server
     * Called when joining a room
     */
    initializeState(state) {
        // Clear everything
        this.committedStrokes.clear();
        this.activeStrokes.clear();

        // Load committed strokes
        if (state.operationLog) {
            for (const stroke of state.operationLog) {
                this.committedStrokes.set(stroke.id, stroke);
            }
        }

        // Load active strokes from other users
        if (state.activeStrokes) {
            for (const stroke of state.activeStrokes) {
                this.activeStrokes.set(stroke.id, stroke);
            }
        }

        // Render everything
        this.renderAllStrokes();
    }

    /**
     * Handle stroke preview from another user
     */
    handleStrokePreview(data) {
        if (data.type === 'start') {
            // New stroke from another user
            this.activeStrokes.set(data.stroke.id, {
                ...data.stroke,
                points: data.stroke.points || []
            });
        } else if (data.type === 'update') {
            // Update existing preview stroke
            const stroke = this.activeStrokes.get(data.strokeId);
            if (stroke && data.points) {
                stroke.points.push(...data.points);
            }
        }

        // Render active strokes
        this.renderActiveStrokes();
    }

    /**
     * Handle stroke commit from server
     * This is the authoritative version
     */
    handleStrokeCommit(stroke) {
        // Remove from active strokes
        this.activeStrokes.delete(stroke.id);

        // Add to committed strokes
        this.committedStrokes.set(stroke.id, stroke);

        // Clear active canvas and redraw (removes our local preview)
        this.clearCanvas(this.activeCtx);

        // Draw the committed stroke to strokes layer
        if (!stroke.isUndone) {
            this.drawStroke(this.strokesCtx, stroke);
        }

        // Redraw remaining active strokes (other users)
        this.renderActiveStrokes();
    }

    /**
     * Handle stroke cancellation
     */
    handleStrokeCancel(strokeId) {
        this.activeStrokes.delete(strokeId);
        this.renderActiveStrokes();
    }

    /**
     * Handle undo event
     * Marks stroke as undone and re-renders
     */
    handleUndo(strokeId) {
        const stroke = this.committedStrokes.get(strokeId);
        if (stroke) {
            stroke.isUndone = true;
            this.renderAllStrokes();
        }
    }

    /**
     * Handle redo event
     * Marks stroke as visible and re-renders
     */
    handleRedo(strokeId) {
        const stroke = this.committedStrokes.get(strokeId);
        if (stroke) {
            stroke.isUndone = false;
            this.renderAllStrokes();
        }
    }

    /**
     * Handle canvas clear
     */
    handleClear() {
        this.committedStrokes.clear();
        this.activeStrokes.clear();
        this.clearCanvas(this.strokesCtx);
        this.clearCanvas(this.activeCtx);
    }

    // ==========================================
    // Rendering
    // ==========================================

    /**
     * Clear a canvas context
     */
    clearCanvas(ctx) {
        const canvas = ctx.canvas;
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
    }

    /**
     * Re-render all committed strokes
     * Called after undo/redo/resize
     */
    renderAllStrokes() {
        this.clearCanvas(this.strokesCtx);

        // Sort by sequence number for correct ordering
        const strokes = Array.from(this.committedStrokes.values())
            .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

        for (const stroke of strokes) {
            if (!stroke.isUndone) {
                this.drawStroke(this.strokesCtx, stroke);
            }
        }
    }

    /**
     * Render active strokes (other users' in-progress strokes)
     */
    renderActiveStrokes() {
        this.clearCanvas(this.activeCtx);

        // Redraw current local stroke if any
        if (this.currentStroke) {
            this.drawStroke(this.activeCtx, this.currentStroke);
        }

        // Draw other users' active strokes
        for (const stroke of this.activeStrokes.values()) {
            this.drawStroke(this.activeCtx, stroke);
        }
    }

    // ==========================================
    // Cursor Rendering
    // ==========================================

    /**
     * Update remote cursor position
     */
    updateRemoteCursor(data) {
        this.remoteCursors.set(data.userId, {
            x: data.x,
            y: data.y,
            name: data.name,
            color: data.color,
            isDrawing: data.isDrawing,
            lastUpdate: Date.now()
        });
    }

    /**
     * Remove remote cursor
     */
    removeRemoteCursor(userId) {
        this.remoteCursors.delete(userId);
    }

    /**
     * Start cursor animation loop
     */
    startCursorAnimation() {
        const animate = () => {
            this.renderCursors();
            this.cursorAnimationFrame = requestAnimationFrame(animate);
        };
        animate();
    }

    /**
     * Stop cursor animation
     */
    stopCursorAnimation() {
        if (this.cursorAnimationFrame) {
            cancelAnimationFrame(this.cursorAnimationFrame);
        }
    }

    /**
     * Render all remote cursors
     */
    renderCursors() {
        this.clearCanvas(this.cursorsCtx);
        const ctx = this.cursorsCtx;
        const now = Date.now();

        for (const [userId, cursor] of this.remoteCursors) {
            // Skip stale cursors (no update in 5 seconds)
            if (now - cursor.lastUpdate > 5000) {
                this.remoteCursors.delete(userId);
                continue;
            }

            const x = cursor.x;
            const y = cursor.y;

            // Draw cursor indicator
            ctx.save();

            // Cursor arrow
            ctx.fillStyle = cursor.color;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + 18);
            ctx.lineTo(x + 5, y + 14);
            ctx.lineTo(x + 10, y + 22);
            ctx.lineTo(x + 13, y + 20);
            ctx.lineTo(x + 8, y + 12);
            ctx.lineTo(x + 14, y + 10);
            ctx.closePath();
            ctx.fill();

            // Cursor outline for visibility
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Name label
            const label = cursor.name;
            ctx.font = '12px Inter, sans-serif';
            const metrics = ctx.measureText(label);
            const labelWidth = metrics.width + 12;
            const labelHeight = 20;
            const labelX = x + 16;
            const labelY = y + 10;

            // Label background
            ctx.fillStyle = cursor.color;
            ctx.beginPath();
            ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 4);
            ctx.fill();

            // Label text
            ctx.fillStyle = 'white';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, labelX + 6, labelY + labelHeight / 2);

            // Drawing indicator (dot if user is drawing)
            if (cursor.isDrawing) {
                ctx.fillStyle = '#10b981';
                ctx.beginPath();
                ctx.arc(x - 4, y - 4, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            ctx.restore();
        }
    }

    // ==========================================
    // Tool Settings
    // ==========================================

    setTool(tool) {
        this.tool = tool;
    }

    setColor(color) {
        this.color = color;
    }

    setWidth(width) {
        this.width = width;
    }

    // ==========================================
    // Cleanup
    // ==========================================

    destroy() {
        this.stopCursorAnimation();
        window.removeEventListener('resize', this.resize);
    }
}

// Export for use in main.js
window.DrawingCanvas = DrawingCanvas;
