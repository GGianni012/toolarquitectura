import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import './ControlsGuide.css';

function isTypingTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return element?.tagName === 'INPUT'
        || element?.tagName === 'TEXTAREA'
        || element?.tagName === 'SELECT'
        || !!element?.isContentEditable;
}

export default function ControlsGuide() {
    const { mode, setMode, selectedElement, setSelectedElement } = useStore();
    const [isOpen, setIsOpen] = useState(true);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isTypingTarget(event.target)) return;

            if (event.code === 'Slash' && event.shiftKey) {
                event.preventDefault();
                setIsOpen((value) => !value);
                return;
            }

            if (event.code === 'Digit1') {
                event.preventDefault();
                setMode('2D');
                return;
            }

            if (event.code === 'Digit2') {
                event.preventDefault();
                setMode('3D');
                return;
            }

            if (event.code === 'Escape') {
                setSelectedElement(null);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [setMode, setSelectedElement]);

    if (!isOpen) {
        return (
            <button className="controls-guide-toggle" onClick={() => setIsOpen(true)} title="Show shortcuts (?)">
                <Keyboard size={18} />
                Shortcuts
            </button>
        );
    }

    return (
        <aside className="controls-guide glass-panel">
            <div className="controls-guide-header">
                <div className="controls-guide-title">
                    <Keyboard size={16} />
                    Shortcuts
                </div>
                <button className="controls-guide-close" onClick={() => setIsOpen(false)} title="Hide shortcuts (?)">
                    <X size={16} />
                </button>
            </div>

            <div className="controls-guide-section">
                <h4>General</h4>
                <div className="controls-guide-row"><kbd>1</kbd><span>Switch to 2D planner</span></div>
                <div className="controls-guide-row"><kbd>2</kbd><span>Switch to 3D viewer</span></div>
                <div className="controls-guide-row"><kbd>Esc</kbd><span>{selectedElement ? 'Clear current selection' : 'Close active selection'}</span></div>
                <div className="controls-guide-row"><kbd>Delete</kbd><span>Remove selected element</span></div>
                <div className="controls-guide-row"><kbd>Ctrl/Cmd</kbd> + <kbd>C</kbd><span>Copy selected room or furniture</span></div>
                <div className="controls-guide-row"><kbd>Ctrl/Cmd</kbd> + <kbd>V</kbd><span>Paste copied room or furniture</span></div>
                <div className="controls-guide-row"><kbd>?</kbd><span>Show or hide this panel</span></div>
            </div>

            {mode === '2D' ? (
                <div className="controls-guide-section">
                    <h4>2D Planner</h4>
                    <div className="controls-guide-row"><kbd>Space</kbd><span>Hold and drag to pan</span></div>
                    <div className="controls-guide-row"><kbd>Alt</kbd><span>Hold and drag to pan</span></div>
                    <div className="controls-guide-row"><kbd>Ctrl</kbd> + <kbd>Wheel</kbd><span>Zoom in or out</span></div>
                    <div className="controls-guide-row"><kbd>Draw Room</kbd><span>Create modular rooms point by point</span></div>
                    <div className="controls-guide-note">The background grid is only a visual guide. Snapping still pulls edges and points together.</div>
                </div>
            ) : (
                <div className="controls-guide-section">
                    <h4>3D Viewer</h4>
                    <div className="controls-guide-row"><kbd>W A S D</kbd><span>Move through the scene</span></div>
                    <div className="controls-guide-row"><kbd>Arrows</kbd><span>Move through the scene</span></div>
                    <div className="controls-guide-row"><kbd>Shift</kbd><span>Move faster</span></div>
                    <div className="controls-guide-row"><kbd>Mouse drag</kbd><span>Orbit around the building</span></div>
                    <div className="controls-guide-row"><kbd>Right drag</kbd><span>Pan the camera</span></div>
                    <div className="controls-guide-row"><kbd>Wheel</kbd><span>Zoom the camera</span></div>
                    <div className="controls-guide-row"><kbd>Click</kbd><span>Select rooms and objects directly in 3D</span></div>
                    <div className="controls-guide-row"><kbd>F</kbd><span>Fit the full building in view</span></div>
                </div>
            )}
        </aside>
    );
}
