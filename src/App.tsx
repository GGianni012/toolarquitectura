import { useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Canvas2D from './components/2d/Canvas2D';
import Canvas3D from './components/3d/Canvas3D';
import PropertiesPanel from './components/PropertiesPanel';
import ControlsGuide from './components/ControlsGuide';
import './App.css';

function App() {
    const { mode, selectedElement, rooms, addRoom } = useStore();
    const copiedRoomRef = useRef<any>(null);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const isTypingTarget = target?.tagName === 'INPUT'
                || target?.tagName === 'TEXTAREA'
                || target?.tagName === 'SELECT'
                || !!target?.isContentEditable;

            if (isTypingTarget || !(event.metaKey || event.ctrlKey)) {
                return;
            }

            if (event.code === 'KeyC' && selectedElement?.type === 'room') {
                const room = rooms.find((item) => item.id === selectedElement.id);
                if (!room) return;

                event.preventDefault();
                copiedRoomRef.current = structuredClone(room);
                return;
            }

            if (event.code === 'KeyV' && copiedRoomRef.current) {
                event.preventDefault();
                const room = copiedRoomRef.current;
                const offset = 1;
                addRoom({
                    ...room,
                    points: room.points?.map((point: { x: number; y: number }) => ({ x: point.x + offset, y: point.y + offset })),
                    x: room.x + offset,
                    y: room.y + offset,
                    name: room.name ? `${room.name} Copy` : 'Room Copy'
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [addRoom, rooms, selectedElement]);

    return (
        <div className="app-container">
            <Header />
            <div className="main-content">
                <Sidebar />
                <div className="canvas-wrapper" style={{ position: 'relative' }}>
                    {mode === '2D' ? <Canvas2D /> : <Canvas3D />}
                    <PropertiesPanel />
                    <ControlsGuide />
                </div>
            </div>
        </div>
    );
}

export default App;
