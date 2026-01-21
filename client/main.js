/**
 * Main Application - Orchestrates the collaborative canvas
 * 
 * Responsibilities:
 * - Initialize canvas and WebSocket client
 * - Bind UI events (toolbar, keyboard shortcuts)
 * - Coordinate between canvas drawing and network events
 * - Manage user presence display
 * - Handle toast notifications
 */

(function () {
    'use strict';

    // ==========================================
    // Application State
    // ==========================================

    const app = {
        canvas: null,
        wsClient: null,
        users: new Map(),
        currentUser: null,
        canUndo: false,
        canRedo: false
    };

    // ==========================================
    // DOM Elements
    // ==========================================

    const elements = {
        joinModal: document.getElementById('join-modal'),
        joinForm: document.getElementById('join-form'),
        roomInput: document.getElementById('room-input'),
        nameInput: document.getElementById('name-input'),
        appContainer: document.getElementById('app'),
        canvasContainer: document.getElementById('canvas-container'),
        roomNameDisplay: document.getElementById('room-name-display'),
        toolbar: document.getElementById('toolbar'),
        colorPicker: document.getElementById('color-picker'),
        colorPreview: document.getElementById('color-preview'),
        strokeWidth: document.getElementById('stroke-width'),
        widthValue: document.getElementById('width-value'),
        widthPreview: document.getElementById('width-preview'),
        undoBtn: document.getElementById('undo-btn'),
        redoBtn: document.getElementById('redo-btn'),
        clearBtn: document.getElementById('clear-btn'),
        usersCount: document.getElementById('users-count'),
        usersList: document.getElementById('users-list'),
        toastContainer: document.getElementById('toast-container'),
        connectionStatus: document.getElementById('connection-status')
    };

    // ==========================================
    // Initialization
    // ==========================================

    async function init() {
        console.log('[App] Initializing collaborative canvas...');

        // Initialize canvas
        app.canvas = new DrawingCanvas(elements.canvasContainer);

        // Initialize WebSocket client
        app.wsClient = new WebSocketClient();

        // Setup callbacks
        setupCanvasCallbacks();
        setupWebSocketCallbacks();
        setupUIEvents();
        setupKeyboardShortcuts();

        // Connect to server
        try {
            await app.wsClient.connect();
            updateConnectionStatus('connected');
        } catch (error) {
            console.error('[App] Failed to connect:', error);
            updateConnectionStatus('disconnected');
            showToast('Failed to connect to server', 'error');
        }

        // Update initial UI state
        updateColorPreview();
        updateWidthPreview();

        console.log('[App] Initialization complete');
    }

    // ==========================================
    // Canvas Callbacks
    // ==========================================

    function setupCanvasCallbacks() {
        // When user starts a stroke
        app.canvas.onStrokeStart = (stroke) => {
            app.wsClient.startStroke(stroke);
        };

        // When user adds points to stroke
        app.canvas.onStrokeUpdate = (strokeId, points) => {
            app.wsClient.updateStroke(strokeId, points);
        };

        // When user ends a stroke
        app.canvas.onStrokeEnd = (strokeId) => {
            app.wsClient.endStroke(strokeId);
        };

        // When user moves cursor
        app.canvas.onCursorMove = (x, y) => {
            app.wsClient.updateCursor(x, y);
        };
    }

    // ==========================================
    // WebSocket Callbacks
    // ==========================================

    function setupWebSocketCallbacks() {
        // Connection events
        app.wsClient.on('connect', () => {
            updateConnectionStatus('connected');
        });

        app.wsClient.on('disconnect', (reason) => {
            updateConnectionStatus('disconnected');
            showToast('Disconnected from server', 'warning');
        });

        // Room joined
        app.wsClient.on('roomJoined', (user, state) => {
            app.currentUser = user;

            // Update room name display
            elements.roomNameDisplay.textContent = `Room: ${app.wsClient.getRoom()}`;

            // Initialize canvas with server state
            app.canvas.initializeState(state.drawing);

            // Update users list
            app.users.clear();
            for (const u of state.users) {
                app.users.set(u.id, u);
            }
            updateUsersList();

            // Update undo/redo state
            updateUndoRedoState(state.drawing);

            showToast(`Joined as ${user.name}`, 'success');
        });

        // Stroke preview from other users
        app.wsClient.on('strokePreview', (data) => {
            app.canvas.handleStrokePreview(data);
        });

        // Stroke committed by server
        app.wsClient.on('strokeCommit', (stroke) => {
            app.canvas.handleStrokeCommit(stroke);
        });

        // Stroke cancelled
        app.wsClient.on('strokeCancel', (strokeId) => {
            app.canvas.handleStrokeCancel(strokeId);
        });

        // Cursor update from other user
        app.wsClient.on('cursorUpdate', (data) => {
            app.canvas.updateRemoteCursor(data);

            // Update user drawing state
            const user = app.users.get(data.userId);
            if (user) {
                user.isDrawing = data.isDrawing;
                updateUsersList();
            }
        });

        // Global undo
        app.wsClient.on('undo', (strokeId, userName) => {
            app.canvas.handleUndo(strokeId);
            showToast(`${userName} undid a stroke`, 'info');
        });

        // Global redo
        app.wsClient.on('redo', (strokeId, userName) => {
            app.canvas.handleRedo(strokeId);
            showToast(`${userName} redid a stroke`, 'info');
        });

        // Undo/redo state update
        app.wsClient.on('undoRedoState', (state) => {
            updateUndoRedoState(state);
        });

        // User join
        app.wsClient.on('userJoin', (user) => {
            app.users.set(user.id, user);
            updateUsersList();
            showToast(`${user.name} joined`, 'info');
        });

        // User leave
        app.wsClient.on('userLeave', (userId, userName) => {
            app.users.delete(userId);
            app.canvas.removeRemoteCursor(userId);
            updateUsersList();
            showToast(`${userName} left`, 'info');
        });

        // Canvas clear
        app.wsClient.on('canvasClear', (userName) => {
            app.canvas.handleClear();
            showToast(`${userName} cleared the canvas`, 'warning');
        });
    }

    // ==========================================
    // UI Event Handlers
    // ==========================================

    function setupUIEvents() {
        // Join form submission
        elements.joinForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const roomId = elements.roomInput.value.trim() || 'default';
            const userName = elements.nameInput.value.trim() || null;

            try {
                await app.wsClient.joinRoom(roomId, userName);

                // Hide modal, show app
                elements.joinModal.classList.add('hidden');
                elements.appContainer.classList.remove('hidden');

                // Trigger resize to ensure canvas is properly sized
                setTimeout(() => {
                    app.canvas.resize();
                }, 100);

            } catch (error) {
                console.error('[App] Failed to join room:', error);
                showToast('Failed to join room', 'error');
            }
        });

        // Tool selection
        elements.toolbar.addEventListener('click', (e) => {
            const toolBtn = e.target.closest('.tool-btn[data-tool]');
            if (toolBtn) {
                selectTool(toolBtn.dataset.tool);
            }
        });

        // Color picker
        elements.colorPreview.addEventListener('click', () => {
            elements.colorPicker.click();
        });

        elements.colorPicker.addEventListener('input', (e) => {
            const color = e.target.value;
            app.canvas.setColor(color);
            updateColorPreview();
        });

        // Quick color buttons
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                elements.colorPicker.value = color;
                app.canvas.setColor(color);
                updateColorPreview();
            });
        });

        // Stroke width
        elements.strokeWidth.addEventListener('input', (e) => {
            const width = parseInt(e.target.value);
            app.canvas.setWidth(width);
            updateWidthPreview();
        });

        // Undo button
        elements.undoBtn.addEventListener('click', () => {
            app.wsClient.undo();
        });

        // Redo button
        elements.redoBtn.addEventListener('click', () => {
            app.wsClient.redo();
        });

        // Clear button
        elements.clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the canvas? This cannot be undone.')) {
                app.wsClient.clearCanvas();
            }
        });
    }

    // ==========================================
    // Keyboard Shortcuts
    // ==========================================

    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Undo: Ctrl+Z or Cmd+Z
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                app.wsClient.undo();
            }

            // Redo: Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                app.wsClient.redo();
            }

            // Brush tool: B
            if (e.key === 'b' || e.key === 'B') {
                selectTool('brush');
            }

            // Eraser tool: E
            if (e.key === 'e' || e.key === 'E') {
                selectTool('eraser');
            }

            // Increase stroke width: ]
            if (e.key === ']') {
                const newWidth = Math.min(50, parseInt(elements.strokeWidth.value) + 2);
                elements.strokeWidth.value = newWidth;
                app.canvas.setWidth(newWidth);
                updateWidthPreview();
            }

            // Decrease stroke width: [
            if (e.key === '[') {
                const newWidth = Math.max(1, parseInt(elements.strokeWidth.value) - 2);
                elements.strokeWidth.value = newWidth;
                app.canvas.setWidth(newWidth);
                updateWidthPreview();
            }
        });
    }

    // ==========================================
    // UI Update Functions
    // ==========================================

    function selectTool(tool) {
        app.canvas.setTool(tool);

        // Update active button
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
    }

    function updateColorPreview() {
        const color = elements.colorPicker.value;
        elements.colorPreview.style.background = color;
    }

    function updateWidthPreview() {
        const width = elements.strokeWidth.value;
        elements.widthValue.textContent = width;

        // Scale preview dot (max 16px)
        const previewSize = Math.min(16, Math.max(4, width * 0.8));
        elements.widthPreview.style.width = previewSize + 'px';
        elements.widthPreview.style.height = previewSize + 'px';
    }

    function updateUndoRedoState(state) {
        app.canUndo = state.canUndo;
        app.canRedo = state.canRedo;

        elements.undoBtn.disabled = !app.canUndo;
        elements.redoBtn.disabled = !app.canRedo;
    }

    function updateUsersList() {
        const count = app.users.size;
        elements.usersCount.querySelector('.count').textContent = count;

        // Clear and rebuild users list
        elements.usersList.innerHTML = '';

        // Show max 5 avatars
        let shown = 0;
        for (const user of app.users.values()) {
            if (shown >= 5) break;

            const avatar = document.createElement('div');
            avatar.className = 'user-avatar';
            if (user.isDrawing) {
                avatar.classList.add('is-drawing');
            }
            avatar.style.backgroundColor = user.color;
            avatar.textContent = user.name.charAt(0).toUpperCase();
            avatar.title = user.name;

            elements.usersList.appendChild(avatar);
            shown++;
        }

        // Show "+N" if more users
        if (count > 5) {
            const more = document.createElement('div');
            more.className = 'user-avatar';
            more.style.backgroundColor = '#666';
            more.textContent = `+${count - 5}`;
            elements.usersList.appendChild(more);
        }
    }

    function updateConnectionStatus(status) {
        const statusElement = elements.connectionStatus;
        const textElement = statusElement.querySelector('.status-text');

        statusElement.className = 'connection-status ' + status;

        switch (status) {
            case 'connected':
                textElement.textContent = 'Connected';
                break;
            case 'disconnected':
                textElement.textContent = 'Disconnected';
                break;
            default:
                textElement.textContent = 'Connecting...';
        }
    }

    // ==========================================
    // Toast Notifications
    // ==========================================

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        // Icon based on type
        const icons = {
            info: 'ℹ️',
            success: '✅',
            warning: '⚠️',
            error: '❌'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
        `;

        elements.toastContainer.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    }

    // ==========================================
    // Start Application
    // ==========================================

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
