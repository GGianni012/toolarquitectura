import { Cuboid, MousePointer2, PenLine } from 'lucide-react';
import { useStore } from '../store/useStore';

export default function Header() {
    const { mode, setMode, interactMode, setInteractMode, floors, activeFloorId } = useStore();
    const activeFloor = floors.find((floor) => floor.id === activeFloorId);

    return (
        <header className="header glass-panel">
            <div className="header-title">
                <Cuboid size={28} color="#4facfe" />
                DreamSpace
                {activeFloor && (
                    <span className="header-floor-pill">
                        {mode === '2D' ? activeFloor.name : `${floors.filter((floor) => floor.visible).length} levels visible`}
                    </span>
                )}
            </div>

            {mode === '2D' && (
                <div className="mode-toggle">
                    <button
                        className={`mode-btn ${interactMode === 'select' ? 'active' : ''}`}
                        onClick={() => setInteractMode('select')}
                        title="Select & Move"
                    >
                        <MousePointer2 size={16} style={{ marginBottom: '-3px' }} />
                    </button>
                    <button
                        className={`mode-btn ${interactMode === 'draw_wall' ? 'active' : ''}`}
                        onClick={() => setInteractMode('draw_wall')}
                        title="Draw Walls"
                    >
                        <PenLine size={16} style={{ marginBottom: '-3px' }} />
                    </button>
                </div>
            )}

            <div className="mode-toggle">
                <button
                    className={`mode-btn ${mode === '2D' ? 'active' : ''}`}
                    onClick={() => setMode('2D')}
                >
                    2D Planner
                </button>
                <button
                    className={`mode-btn ${mode === '3D' ? 'active' : ''}`}
                    onClick={() => setMode('3D')}
                >
                    3D Viewer
                </button>
            </div>
        </header>
    );
}
