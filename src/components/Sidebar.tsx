import { useRef, useState } from 'react';
import { useStore, InteractMode, defaultLayerSettings } from '../store/useStore';
import { Square, Circle, DoorOpen, MousePointer2, PenTool, Hexagon, Layers3, Plus, Eye, EyeOff, Upload, ArrowUpDown } from 'lucide-react';
import { importReferenceFile } from '../utils/referenceImport';
import { autoTraceReference } from '../utils/autoTraceReference';
import { FURNITURE_PRESETS } from '../utils/furnitureCatalog';
import './Sidebar.css';

function getFurnitureGlyph(type: string) {
    switch (type) {
        case 'sofa': return 'SF';
        case 'bed': return 'BD';
        case 'plant': return 'PL';
        case 'dining_table': return 'TB';
        case 'round_table': return 'RT';
        case 'dining_chair': return 'CH';
        case 'bar_stool': return 'BS';
        case 'booth_seat': return 'BT';
        case 'corner_booth': return 'CB';
        case 'service_counter': return 'CT';
        case 'host_stand': return 'HS';
        case 'prep_table': return 'PT';
        case 'stove_range': return 'ST';
        case 'fryer_station': return 'FY';
        case 'oven_unit': return 'OV';
        case 'double_sink': return 'SK';
        case 'fridge_display': return 'FR';
        case 'display_case': return 'DC';
        case 'espresso_station': return 'ES';
        case 'bakery_rack': return 'BR';
        case 'salad_bar': return 'SB';
        case 'beer_tap': return 'TP';
        default: return 'FM';
    }
}

export default function Sidebar() {
    const {
        addRoom,
        addFurniture,
        addCylinder,
        addStair,
        addFloor,
        updateFloor,
        updateLayerSettings,
        applyAutoTraceResult,
        rooms,
        walls,
        floors,
        activeFloorId,
        interactMode,
        setInteractMode,
        setActiveFloor
    } = useStore();
    const importInputRef = useRef<HTMLInputElement>(null);
    const [isTracingReference, setIsTracingReference] = useState(false);
    const activeFloor = floors.find((floor) => floor.id === activeFloorId);
    const sortedFloors = [...floors].sort((a, b) => a.elevation - b.elevation);
    const previousFloorById = new Map(
        sortedFloors.map((floor, index) => [floor.id, sortedFloors[index - 1] || null])
    );

    const handleAddDoor = () => {
        const floorRooms = rooms.filter((room) => room.floorId === activeFloorId);
        const floorWalls = walls.filter((wall) => wall.floorId === activeFloorId);

        if (floorWalls.length === 0 && floorRooms.length === 0) {
            alert('Create a room or draw a wall first, then click the door tool and place it on an edge.');
            return;
        }

        setInteractMode('place_door');
    };

    const handleAddStair = () => {
        if (floors.length < 2) {
            alert('Create another level first so the stair has somewhere to connect.');
            return;
        }

        const activeIndex = sortedFloors.findIndex((floor) => floor.id === activeFloorId);
        const targetFloor = sortedFloors[activeIndex + 1] || sortedFloors[activeIndex - 1];

        if (!targetFloor) {
            return;
        }

        addStair({
            x: 2,
            y: 2,
            width: 2,
            height: 4,
            targetFloorId: targetFloor.id,
            direction: 'north',
            name: `Stair to ${targetFloor.name}`,
            color: '#ffd166'
        });
    };

    const handleDragStart = (e: React.DragEvent, type: string, payload: any) => {
        e.dataTransfer.setData('application/json', JSON.stringify({ type, payload }));
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleImportClick = () => {
        importInputRef.current?.click();
    };

    const handleReferenceImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeFloor) return;

        try {
            const reference = await importReferenceFile(file);
            updateFloor(activeFloor.id, { reference });
        } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to import reference');
        } finally {
            e.target.value = '';
        }
    };

    const handleAutoTrace = async () => {
        if (!activeFloor?.reference || isTracingReference) {
            return;
        }

        try {
            setIsTracingReference(true);
            const result = await autoTraceReference(activeFloor.reference, {
                wallHeight: activeFloor.height
            });

            if (result.walls.length === 0 && result.rooms.length === 0) {
                alert('I could not read clear walls from that plan. Try increasing the reference scale first or use a higher-contrast image.');
                return;
            }

            applyAutoTraceResult(activeFloor.id, result);
            alert(`Auto trace created ${result.walls.length} walls and ${result.rooms.length} rooms. You can refine everything by hand afterwards.`);
        } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to auto trace the reference');
        } finally {
            setIsTracingReference(false);
        }
    };

    const tools = [
        { id: 'select', name: 'Select & Move', icon: <MousePointer2 size={24} />, mode: 'select' },
        { id: 'draw_wall', name: 'Draw Walls', icon: <PenTool size={24} />, mode: 'draw_wall' },
        { id: 'draw_surface', name: 'Draw Room', icon: <Hexagon size={24} />, mode: 'draw_surface' },
    ];
    const livingFurniture = FURNITURE_PRESETS.filter((preset) => preset.category === 'living');
    const gastronomyFurniture = FURNITURE_PRESETS.filter((preset) => preset.category === 'gastronomy');
    const layerSettings = activeFloor?.layerSettings || defaultLayerSettings;

    return (
        <aside className="sidebar glass-panel">
            <div className="tool-section">
                <div className="section-header">
                    <h3>Levels</h3>
                    <div className="section-actions">
                        <button className="mini-btn" onClick={handleImportClick}>
                            <Upload size={14} />
                            Import
                        </button>
                        <button
                            className="mini-btn"
                            onClick={handleAutoTrace}
                            disabled={!activeFloor?.reference || isTracingReference}
                            title={activeFloor?.reference ? 'Create editable walls and rooms from the active reference' : 'Import a reference first'}
                        >
                            {isTracingReference ? 'Tracing...' : 'Auto Trace'}
                        </button>
                        <button className="mini-btn" onClick={() => addFloor()}>
                            <Plus size={14} />
                            Add
                        </button>
                    </div>
                </div>
                <input
                    ref={importInputRef}
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                    onChange={handleReferenceImport}
                    style={{ display: 'none' }}
                />
                <div className="levels-list">
                    {floors.map((floor) => (
                        <div
                            key={floor.id}
                            className={`level-card ${floor.id === activeFloorId ? 'active' : ''}`}
                            onClick={() => setActiveFloor(floor.id)}
                        >
                            <div className="level-card-main">
                                <div className="level-card-title">
                                    <Layers3 size={16} />
                                    <span>{floor.name}</span>
                                </div>
                                <button
                                    className="icon-toggle"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        updateFloor(floor.id, { visible: !floor.visible });
                                    }}
                                    title={floor.visible ? 'Hide in 3D' : 'Show in 3D'}
                                >
                                    {floor.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                                </button>
                            </div>
                            <div className="level-card-meta">
                                Base {floor.elevation.toFixed(1)}m • Top {(floor.elevation + floor.height).toFixed(1)}m
                                {previousFloorById.get(floor.id)
                                    ? ` • Gap ${(floor.elevation - ((previousFloorById.get(floor.id)?.elevation || 0) + (previousFloorById.get(floor.id)?.height || 0))).toFixed(1)}m`
                                    : ''}
                                {floor.reference ? ` • ${floor.reference.kind.toUpperCase()} ref` : ''}
                            </div>
                            <div
                                className="level-card-controls"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <label className="level-inline-field">
                                    <span>Base</span>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={floor.elevation}
                                        onChange={(event) => updateFloor(floor.id, { elevation: parseFloat(event.target.value) || 0 })}
                                    />
                                </label>
                                <label className="level-inline-field">
                                    <span>Height</span>
                                    <input
                                        type="number"
                                        step="0.1"
                                        min="2"
                                        value={floor.height}
                                        onChange={(event) => updateFloor(floor.id, { height: parseFloat(event.target.value) || 3.2 })}
                                    />
                                </label>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="tool-section">
                <h3>Tools</h3>
                <div className="tool-grid">
                    {tools.map((tool) => (
                        <div
                            key={tool.id}
                            className={`tool-card ${interactMode === tool.mode ? 'active' : ''}`}
                            onClick={() => setInteractMode(tool.mode as InteractMode)}
                        >
                            {tool.icon}
                            <span>{tool.name}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="tool-section">
                <h3>Layers</h3>
                <div className="layer-grid">
                    {layerSettings && ([
                        { key: 'rooms', label: 'Rooms' },
                        { key: 'walls', label: 'Walls' },
                        { key: 'doors', label: 'Doors' },
                        { key: 'furniture', label: 'Furniture' },
                        { key: 'cylinders', label: 'Cylinders' },
                        { key: 'surfaces', label: 'Surfaces' },
                        { key: 'stairs', label: 'Stairs' },
                        { key: 'reference', label: 'Reference' }
                    ] as const).map((layer) => {
                        const state = layerSettings[layer.key];
                        return (
                            <div key={layer.key} className="layer-row">
                                <button
                                    className={`icon-toggle ${state.visible ? 'active' : ''}`}
                                    onClick={() => updateLayerSettings(activeFloorId, layer.key, { visible: !state.visible })}
                                    title={state.visible ? 'Hide layer' : 'Show layer'}
                                >
                                    {state.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                                </button>
                                <div className="layer-label">{layer.label}</div>
                                <input
                                    type="range"
                                    min="0.05"
                                    max="1"
                                    step="0.01"
                                    value={state.opacity}
                                    onChange={(e) => updateLayerSettings(activeFloorId, layer.key, { opacity: parseFloat(e.target.value) })}
                                />
                                <div className="layer-value">{Math.round(state.opacity * 100)}%</div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="tool-section">
                <h3>Building</h3>
                <div className="tool-grid">
                    <div
                        className="tool-card"
                        draggable
                        onDragStart={(e) => handleDragStart(e, 'room', { width: 3, height: 3, rotation: 0, hiddenWallEdges: [], name: 'New Room', color: '#ffb8b8', wallHeight: 3 })}
                        onClick={() => addRoom({ x: 2, y: 2, width: 3, height: 3, rotation: 0, hiddenWallEdges: [], name: 'New Room', color: '#ffb8b8', wallHeight: 3 })}
                    >
                        <Square size={24} />
                        <span>Room</span>
                    </div>
                    <div
                        className="tool-card"
                        draggable
                        onDragStart={(e) => handleDragStart(e, 'cylinder', { radius: 2, name: 'Pillar', wallHeight: 3, color: '#b8ffb8' })}
                        onClick={() => addCylinder({ x: 5, y: 2, radius: 2, name: 'Pillar', wallHeight: 3, color: '#b8ffb8' })}
                    >
                        <Circle size={24} />
                        <span>Cylinder</span>
                    </div>
                    <div
                        className={`tool-card ${interactMode === 'place_door' ? 'active' : ''}`}
                        onClick={handleAddDoor}
                    >
                        <DoorOpen size={24} />
                        <span>Door</span>
                    </div>
                    <div
                        className="tool-card"
                        draggable
                        onDragStart={(e) => {
                            const activeIndex = sortedFloors.findIndex((floor) => floor.id === activeFloorId);
                            const targetFloor = sortedFloors[activeIndex + 1] || sortedFloors[activeIndex - 1];
                            handleDragStart(e, 'stair', {
                                width: 2,
                                height: 4,
                                targetFloorId: targetFloor?.id,
                                direction: 'north',
                                name: targetFloor ? `Stair to ${targetFloor.name}` : 'New Stair',
                                color: '#ffd166'
                            });
                        }}
                        onClick={handleAddStair}
                    >
                        <ArrowUpDown size={24} />
                        <span>Stair</span>
                    </div>
                </div>
            </div>

            <div className="tool-section">
                <h3>Furniture</h3>
                <div className="tool-subsection">
                    <span className="tool-subtitle">Core</span>
                    <div className="tool-grid">
                        {livingFurniture.map((preset, index) => (
                            <div
                                key={preset.type}
                                className="tool-card"
                                draggable
                                onDragStart={(e) => handleDragStart(e, 'furniture', {
                                    type: preset.type,
                                    rotation: 0,
                                    width: preset.width,
                                    depth: preset.depth,
                                    height: preset.height,
                                    color: preset.color,
                                    name: preset.name
                                })}
                                onClick={() => addFurniture({
                                    type: preset.type,
                                    x: 2 + index,
                                    y: 2 + (index % 2),
                                    rotation: 0,
                                    width: preset.width,
                                    depth: preset.depth,
                                    height: preset.height,
                                    color: preset.color,
                                    name: preset.name
                                })}
                            >
                                <div className="tool-card-glyph">{getFurnitureGlyph(preset.type)}</div>
                                <span>{preset.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="tool-subsection">
                    <span className="tool-subtitle">Gastronomy</span>
                    <div className="tool-grid">
                        {gastronomyFurniture.map((preset, index) => (
                            <div
                                key={preset.type}
                                className="tool-card tool-card-gastronomy"
                                draggable
                                onDragStart={(e) => handleDragStart(e, 'furniture', {
                                    type: preset.type,
                                    rotation: 0,
                                    width: preset.width,
                                    depth: preset.depth,
                                    height: preset.height,
                                    color: preset.color,
                                    name: preset.name
                                })}
                                onClick={() => addFurniture({
                                    type: preset.type,
                                    x: 2 + (index % 3),
                                    y: 2 + Math.floor(index / 3),
                                    rotation: 0,
                                    width: preset.width,
                                    depth: preset.depth,
                                    height: preset.height,
                                    color: preset.color,
                                    name: preset.name
                                })}
                            >
                                <div className="tool-card-glyph">{getFurnitureGlyph(preset.type)}</div>
                                <span>{preset.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </aside>
    );
}
