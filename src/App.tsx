import { useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Canvas2D from './components/2d/Canvas2D';
import Canvas3D from './components/3d/Canvas3D';
import PropertiesPanel from './components/PropertiesPanel';
import ControlsGuide from './components/ControlsGuide';
import './App.css';

type ClipboardPayload =
    | { type: 'room'; data: any }
    | { type: 'furniture'; data: any };

function App() {
    const { mode, selectedElement, activeFloorId, rooms, furniture, addRoom, addFurniture, removeElement, setSelectedElement, undo, canUndo } = useStore();
    const clipboardRef = useRef<ClipboardPayload | null>(null);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const isTypingTarget = target?.tagName === 'INPUT'
                || target?.tagName === 'TEXTAREA'
                || target?.tagName === 'SELECT'
                || !!target?.isContentEditable;

            if (isTypingTarget) {
                return;
            }

            if ((event.code === 'Delete' || event.code === 'Backspace') && selectedElement) {
                event.preventDefault();
                removeElement(selectedElement.id, selectedElement.type);
                setSelectedElement(null);
                return;
            }

            if (!(event.metaKey || event.ctrlKey)) {
                return;
            }

            if (event.code === 'KeyZ' && !event.shiftKey) {
                if (!canUndo) return;
                event.preventDefault();
                undo();
                return;
            }

            if (event.code === 'KeyC' && selectedElement) {
                if (selectedElement.type === 'room') {
                    const room = rooms.find((item) => item.id === selectedElement.id);
                    if (!room) return;

                    event.preventDefault();
                    clipboardRef.current = {
                        type: 'room',
                        data: structuredClone(room)
                    };
                    return;
                }

                if (selectedElement.type === 'furniture') {
                    const item = furniture.find((furnitureItem) => furnitureItem.id === selectedElement.id);
                    if (!item) return;

                    event.preventDefault();
                    clipboardRef.current = {
                        type: 'furniture',
                        data: structuredClone(item)
                    };
                }
            }

            if (event.code === 'KeyV' && clipboardRef.current) {
                event.preventDefault();
                const offset = 0.8;

                if (clipboardRef.current.type === 'room') {
                    const room = clipboardRef.current.data;
                    addRoom({
                        ...room,
                        floorId: activeFloorId,
                        showFloor: room.showFloor ?? false,
                        points: room.points?.map((point: { x: number; y: number }) => ({ x: point.x + offset, y: point.y + offset })),
                        x: room.x + offset,
                        y: room.y + offset,
                        name: room.name ? `${room.name} Copy` : 'Room Copy'
                    });
                    return;
                }

                if (clipboardRef.current.type === 'furniture') {
                    const item = clipboardRef.current.data;
                    addFurniture({
                        ...item,
                        floorId: activeFloorId,
                        roomId: item.floorId === activeFloorId ? item.roomId : undefined,
                        x: item.x + offset,
                        y: item.y + offset,
                        name: item.name ? `${item.name} Copy` : 'Furniture Copy'
                    });
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeFloorId, addFurniture, addRoom, canUndo, furniture, removeElement, rooms, selectedElement, setSelectedElement, undo]);

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
