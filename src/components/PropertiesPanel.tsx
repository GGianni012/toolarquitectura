import { useState } from 'react';
import { useDrag } from '@use-gesture/react';
import { useStore } from '../store/useStore';
import { GripHorizontal, Lock, Unlock, X } from 'lucide-react';
import './PropertiesPanel.css';

const PLAN_UNIT_IN_METERS = 0.5;

function formatMeters(value: number) {
    const decimals = Math.abs(value) >= 10 ? 1 : 2;
    return `${value.toFixed(decimals).replace(/\.?0+$/, '')}m`;
}

function formatPlanMeasure(value: number) {
    return formatMeters(value * PLAN_UNIT_IN_METERS);
}

function getPolygonMetrics(points: Array<{ x: number; y: number }>) {
    if (!points || points.length < 2) {
        return { perimeter: 0, area: 0 };
    }

    let perimeter = 0;
    let doubleArea = 0;

    points.forEach((point, index) => {
        const next = points[(index + 1) % points.length];
        perimeter += Math.hypot(next.x - point.x, next.y - point.y);
        doubleArea += point.x * next.y - next.x * point.y;
    });

    return {
        perimeter: perimeter * PLAN_UNIT_IN_METERS,
        area: Math.abs(doubleArea / 2) * PLAN_UNIT_IN_METERS * PLAN_UNIT_IN_METERS
    };
}

function FloorChoiceGroup({
    options,
    value,
    onChange
}: {
    options: Array<{ id: string; name: string }>;
    value: string;
    onChange: (nextId: string) => void;
}) {
    return (
        <div className="floor-choice-group">
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    className={`floor-choice-btn ${option.id === value ? 'active' : ''}`}
                    onClick={() => onChange(option.id)}
                >
                    {option.name}
                </button>
            ))}
        </div>
    );
}

export default function PropertiesPanel() {
    const {
        selectedElement,
        setSelectedElement,
        floors,
        activeFloorId,
        rooms, furniture, walls, doors, cylinders, surfaces, stairs,
        updateFloor,
        updateRoom, updateFurniture, updateWall, updateDoor, updateCylinder, updateSurface, updateStair,
        removeElement
    } = useStore();
    const [panelOffset, setPanelOffset] = useState({ x: 0, y: 0 });
    const dragBind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (first || !memo) {
            memo = { x: panelOffset.x, y: panelOffset.y };
        }

        setPanelOffset({
            x: memo.x + mx,
            y: memo.y + my
        });

        return memo;
    });
    const dragHandleProps: any = dragBind();
    const panelStyle = {
        transform: `translate(${panelOffset.x}px, ${panelOffset.y}px)`
    };

    const activeFloor = floors.find((floor) => floor.id === activeFloorId);

    if (!selectedElement) {
        if (!activeFloor) return null;
        const sortedFloors = [...floors].sort((a, b) => a.elevation - b.elevation);
        const activeFloorIndex = sortedFloors.findIndex((floor) => floor.id === activeFloor.id);
        const previousFloor = sortedFloors[activeFloorIndex - 1];
        const topElevation = activeFloor.elevation + activeFloor.height;
        const floorGap = previousFloor
            ? activeFloor.elevation - (previousFloor.elevation + previousFloor.height)
            : activeFloor.elevation;

        const updateReference = (data: Partial<NonNullable<typeof activeFloor.reference>>) => {
            if (!activeFloor.reference) return;
            updateFloor(activeFloor.id, {
                reference: {
                    ...activeFloor.reference,
                    ...data
                }
            });
        };

        return (
            <div className="properties-panel" style={panelStyle}>
                <div className="properties-header draggable" {...dragHandleProps}>
                    <h3>{activeFloor.name} Settings</h3>
                    <div className="properties-header-tools">
                        <span className="properties-drag-pill">
                            <GripHorizontal size={14} />
                            Move
                        </span>
                    </div>
                </div>

                <div className="properties-content">
                    <div className="property-row stacked">
                        <label>Name</label>
                        <input
                            type="text"
                            value={activeFloor.name}
                            onChange={(e) => updateFloor(activeFloor.id, { name: e.target.value })}
                            placeholder="Floor name"
                        />
                    </div>

                    <div className="property-row">
                        <label>Elevation</label>
                        <input
                            type="number"
                            step="0.1"
                            value={activeFloor.elevation}
                            onChange={(e) => updateFloor(activeFloor.id, { elevation: parseFloat(e.target.value) || 0 })}
                        />
                    </div>

                    <div className="property-row">
                        <label>Level Height</label>
                        <input
                            type="number"
                            step="0.1"
                            min="2"
                            value={activeFloor.height}
                            onChange={(e) => updateFloor(activeFloor.id, { height: parseFloat(e.target.value) || 3.2 })}
                        />
                    </div>

                    <div className="property-row stacked">
                        <label>Open Side</label>
                        <select
                            value={activeFloor.openSide}
                            onChange={(e) => updateFloor(activeFloor.id, { openSide: e.target.value as typeof activeFloor.openSide })}
                        >
                            <option value="south">South</option>
                            <option value="north">North</option>
                            <option value="east">East</option>
                            <option value="west">West</option>
                            <option value="none">Closed Box</option>
                        </select>
                    </div>

                    <div className="property-row">
                        <label>Visible in 3D</label>
                        <button
                            className={`lock-btn ${activeFloor.visible ? '' : 'locked'}`}
                            onClick={() => updateFloor(activeFloor.id, { visible: !activeFloor.visible })}
                        >
                            {activeFloor.visible ? 'Visible' : 'Hidden'}
                        </button>
                    </div>

                    <div className="property-row stacked">
                        <label>Level Metrics</label>
                        <div className="metrics-grid">
                            <div className="metric-card">
                                <span>Base</span>
                                <strong>{formatMeters(activeFloor.elevation)}</strong>
                            </div>
                            <div className="metric-card">
                                <span>Top</span>
                                <strong>{formatMeters(topElevation)}</strong>
                            </div>
                            <div className="metric-card">
                                <span>Gap Below</span>
                                <strong>{formatMeters(floorGap)}</strong>
                            </div>
                        </div>
                    </div>

                    {activeFloor.reference && (
                        <>
                            <div className="property-row stacked">
                                <label>Reference</label>
                                <div className="property-chip">
                                    {activeFloor.reference.name}
                                </div>
                            </div>
                            <div className="property-row">
                                <label>Opacity</label>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="1"
                                    step="0.01"
                                    value={activeFloor.reference.opacity}
                                    onChange={(e) => updateReference({ opacity: parseFloat(e.target.value) })}
                                />
                            </div>
                            <div className="property-row">
                                <label>Scale</label>
                                <input
                                    type="number"
                                    step="0.05"
                                    min="0.2"
                                    value={activeFloor.reference.scale}
                                    onChange={(e) => updateReference({ scale: parseFloat(e.target.value) || 1 })}
                                />
                            </div>
                            <div className="property-row">
                                <label>Offset X</label>
                                <input
                                    type="number"
                                    step="1"
                                    value={activeFloor.reference.offsetX}
                                    onChange={(e) => updateReference({ offsetX: parseFloat(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="property-row">
                                <label>Offset Y</label>
                                <input
                                    type="number"
                                    step="1"
                                    value={activeFloor.reference.offsetY}
                                    onChange={(e) => updateReference({ offsetY: parseFloat(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="property-row">
                                <label>Reference Lock</label>
                                <button
                                    className={`lock-btn ${activeFloor.reference.locked ? 'locked' : ''}`}
                                    onClick={() => updateReference({ locked: !activeFloor.reference?.locked })}
                                >
                                    {activeFloor.reference.locked ? 'Locked' : 'Unlocked'}
                                </button>
                            </div>
                            <button
                                className="delete-btn"
                                onClick={() => updateFloor(activeFloor.id, { reference: null })}
                            >
                                Remove reference
                            </button>
                        </>
                    )}

                    <p className="property-hint">
                        New elements are created on this level. Select a room or stair to move it to another plant after drawing.
                    </p>
                </div>
            </div>
        );
    }

    const { id, type } = selectedElement;

    // Retrieve the actual object from store based on type
    let element: any = null;
    let updateFn: any = null;

    switch (type) {
        case 'room': element = rooms.find(r => r.id === id); updateFn = updateRoom; break;
        case 'furniture': element = furniture.find(f => f.id === id); updateFn = updateFurniture; break;
        case 'wall': element = walls.find(w => w.id === id); updateFn = updateWall; break;
        case 'door': element = doors.find(d => d.id === id); updateFn = updateDoor; break;
        case 'cylinder': element = cylinders.find(c => c.id === id); updateFn = updateCylinder; break;
        case 'surface': element = surfaces.find(s => s.id === id); updateFn = updateSurface; break;
        case 'stair': element = stairs.find(s => s.id === id); updateFn = updateStair; break;
    }

    if (!element || !updateFn) return null;

    const handleChange = (field: string, value: any) => {
        updateFn(id, { [field]: value });
    };

    const canMoveBetweenFloors = type === 'room' || type === 'furniture' || type === 'cylinder' || type === 'surface' || type === 'stair';
    const doorHostLabel = type === 'door'
        ? (element.roomId
            ? (() => {
                const room = rooms.find((roomItem) => roomItem.id === element.roomId);
                return room ? `${room.name || 'Room'} • ${element.edge || 'edge'}` : 'Attached room edge';
            })()
            : (() => {
                const wall = walls.find((wallItem) => wallItem.id === element.wallId);
                return wall ? wall.name || 'Custom wall' : 'Attached wall';
            })())
        : null;
    const measurementRows = (() => {
        switch (type) {
            case 'room':
                return [
                    { label: 'Origin', value: `${formatPlanMeasure(element.x)}, ${formatPlanMeasure(element.y)}` },
                    { label: 'Width', value: formatPlanMeasure(element.width) },
                    { label: 'Depth', value: formatPlanMeasure(element.height) },
                    { label: 'Rotation', value: `${Math.round(element.rotation || 0)}°` },
                    { label: 'Area', value: `${(element.width * element.height * PLAN_UNIT_IN_METERS * PLAN_UNIT_IN_METERS).toFixed(2).replace(/\.?0+$/, '')}m²` }
                ];
            case 'wall':
                return [
                    { label: 'Start', value: `${formatPlanMeasure(element.startX)}, ${formatPlanMeasure(element.startY)}` },
                    { label: 'End', value: `${formatPlanMeasure(element.endX)}, ${formatPlanMeasure(element.endY)}` },
                    { label: 'Length', value: formatPlanMeasure(Math.hypot(element.endX - element.startX, element.endY - element.startY)) },
                    { label: 'Thickness', value: formatMeters(element.thickness || 0.18) }
                ];
            case 'door':
                return [
                    { label: 'Width', value: formatMeters(element.width) },
                    { label: 'Height', value: formatMeters(element.doorHeight || 2.1) },
                    { label: 'Host', value: doorHostLabel || 'Wall' }
                ];
            case 'furniture':
                return [
                    { label: 'Origin', value: `${formatPlanMeasure(element.x)}, ${formatPlanMeasure(element.y)}` },
                    { label: 'Width', value: formatMeters(element.width !== undefined ? element.width : 1) },
                    { label: 'Depth', value: formatMeters(element.depth !== undefined ? element.depth : 1) },
                    { label: 'Height', value: formatMeters(element.height !== undefined ? element.height : 0.5) },
                    { label: 'Rotation', value: `${Math.round(element.rotation || 0)}°` }
                ];
            case 'cylinder':
                return [
                    { label: 'Center', value: `${formatPlanMeasure(element.x)}, ${formatPlanMeasure(element.y)}` },
                    { label: 'Radius', value: formatPlanMeasure(element.radius) },
                    { label: 'Diameter', value: formatPlanMeasure(element.radius * 2) }
                ];
            case 'surface': {
                const { perimeter, area } = getPolygonMetrics(element.points || []);
                return [
                    { label: 'Points', value: `${element.points?.length || 0}` },
                    { label: 'Perimeter', value: formatMeters(perimeter) },
                    { label: 'Area', value: `${area.toFixed(2).replace(/\.?0+$/, '')}m²` }
                ];
            }
            case 'stair':
                return [
                    { label: 'Origin', value: `${formatPlanMeasure(element.x)}, ${formatPlanMeasure(element.y)}` },
                    { label: 'Width', value: formatPlanMeasure(element.width) },
                    { label: 'Run', value: formatPlanMeasure(element.height) }
                ];
            default:
                return [];
        }
    })();

    return (
        <div className="properties-panel" style={panelStyle}>
            <div className="properties-header draggable" {...dragHandleProps}>
                <h3>{element.name || type.charAt(0).toUpperCase() + type.slice(1)} Properties</h3>
                <div className="properties-header-tools">
                    <span className="properties-drag-pill">
                        <GripHorizontal size={14} />
                        Move
                    </span>
                    <button
                        className="icon-btn"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => setSelectedElement(null)}
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            <div className="properties-content">
                <div className="property-row">
                    <label>Name</label>
                    <input
                        type="text"
                        value={element.name || ''}
                        onChange={(e) => handleChange('name', e.target.value)}
                        placeholder="Unnamed item"
                    />
                </div>

                {canMoveBetweenFloors && (
                    <div className="property-row stacked">
                        <label>Level</label>
                        <FloorChoiceGroup
                            options={floors.map((floor) => ({ id: floor.id, name: floor.name }))}
                            value={element.floorId}
                            onChange={(nextId) => handleChange('floorId', nextId)}
                        />
                    </div>
                )}

                <div className="property-row">
                    <label>Color</label>
                    <input
                        type="color"
                        value={element.color || '#ffffff'}
                        onChange={(e) => handleChange('color', e.target.value)}
                    />
                </div>
                {/* Generic Lock Toggle */}
                <div className="property-row">
                    <label>Locked</label>
                    <button
                        className={`lock-btn ${element.locked ? 'locked' : ''}`}
                        onClick={() => handleChange('locked', !element.locked)}
                    >
                        {element.locked ? <Lock size={16} /> : <Unlock size={16} />}
                        {element.locked ? 'Locked' : 'Unlocked'}
                    </button>
                </div>

                {measurementRows.length > 0 && (
                    <div className="property-row stacked">
                        <label>Measurements</label>
                        <div className="metrics-grid">
                            {measurementRows.map((row) => (
                                <div key={row.label} className="metric-card">
                                    <span>{row.label}</span>
                                    <strong>{row.value}</strong>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {type === 'room' && (
                    <>
                        <div className="property-row">
                            <label>X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.x}
                                onChange={(e) => handleChange('x', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.y}
                                onChange={(e) => handleChange('y', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Width</label>
                            <input
                                type="number"
                                step="0.01"
                                min="1"
                                value={element.width}
                                onChange={(e) => handleChange('width', parseFloat(e.target.value) || 1)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Depth</label>
                            <input
                                type="number"
                                step="0.01"
                                min="1"
                                value={element.height}
                                onChange={(e) => handleChange('height', parseFloat(e.target.value) || 1)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Rotation</label>
                            <input
                                type="number"
                                step="1"
                                value={element.rotation || 0}
                                onChange={(e) => handleChange('rotation', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                    </>
                )}

                {/* 3D Wall Height / Extrusion */}
                {(type === 'room' || type === 'cylinder' || type === 'wall') && (
                    <div className="property-row">
                        <label>Wall Height (m)</label>
                        <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={element.wallHeight || 3}
                            onChange={(e) => handleChange('wallHeight', parseFloat(e.target.value))}
                        />
                    </div>
                )}

                {/* Radius for Cylinders */}
                {type === 'cylinder' && (
                    <>
                        <div className="property-row">
                            <label>Center X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.x}
                                onChange={(e) => handleChange('x', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Center Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.y}
                                onChange={(e) => handleChange('y', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Radius (m)</label>
                            <input
                                type="number"
                                step="0.1"
                                min="0.5"
                                value={element.radius || 2}
                                onChange={(e) => handleChange('radius', parseFloat(e.target.value))}
                            />
                        </div>
                    </>
                )}

                {/* Altitude for Furniture */}
                {type === 'furniture' && (
                    <>
                        <div className="property-row">
                            <label>X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.x}
                                onChange={(e) => handleChange('x', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.y}
                                onChange={(e) => handleChange('y', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Width</label>
                            <input
                                type="number"
                                step="0.05"
                                min="0.2"
                                value={element.width !== undefined ? element.width : 1}
                                onChange={(e) => handleChange('width', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="property-row">
                            <label>Depth</label>
                            <input
                                type="number"
                                step="0.05"
                                min="0.2"
                                value={element.depth !== undefined ? element.depth : 1}
                                onChange={(e) => handleChange('depth', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="property-row">
                            <label>Height</label>
                            <input
                                type="number"
                                step="0.05"
                                min="0.2"
                                value={element.height !== undefined ? element.height : 0.5}
                                onChange={(e) => handleChange('height', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="property-row">
                            <label>Rotation</label>
                            <input
                                type="number"
                                step="1"
                                value={element.rotation || 0}
                                onChange={(e) => handleChange('rotation', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Elevation (m)</label>
                            <input
                                type="number"
                                step="0.1"
                                value={element.altitude || 0}
                                onChange={(e) => handleChange('altitude', parseFloat(e.target.value))}
                            />
                        </div>
                    </>
                )}

                {/* Position along Wall for Doors */}
                {type === 'door' && (
                    <>
                        <div className="property-row stacked">
                            <label>Attached To</label>
                            <div className="property-chip">
                                {doorHostLabel}
                            </div>
                        </div>
                        <div className="property-row">
                            <label>Width</label>
                            <input
                                type="number"
                                step="0.05"
                                min="0.2"
                                value={element.width || 0.9}
                                onChange={(e) => handleChange('width', parseFloat(e.target.value) || 0.9)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Height</label>
                            <input
                                type="number"
                                step="0.05"
                                min="1.6"
                                value={element.doorHeight || 2.1}
                                onChange={(e) => handleChange('doorHeight', parseFloat(e.target.value) || 2.1)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Position Setup (%)</label>
                            <input
                                type="range"
                                min="0" max="1" step="0.01"
                                value={element.ratio || 0.5}
                                onChange={(e) => handleChange('ratio', parseFloat(e.target.value))}
                            />
                        </div>
                    </>
                )}

                {/* Surface properties */}
                {type === 'surface' && (
                    <>
                        <div className="property-row">
                            <label>Altitude (m)</label>
                            <input
                                type="number"
                                step="0.1"
                                value={element.altitude || 0}
                                onChange={(e) => handleChange('altitude', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="property-row">
                            <label>Depth / Thickness (m)</label>
                            <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={element.depth !== undefined ? element.depth : 0.1}
                                onChange={(e) => handleChange('depth', parseFloat(e.target.value))}
                            />
                        </div>
                    </>
                )}

                {type === 'stair' && (
                    <>
                        <div className="property-row">
                            <label>X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.x}
                                onChange={(e) => handleChange('x', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.y}
                                onChange={(e) => handleChange('y', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row stacked">
                            <label>Target Level</label>
                            <FloorChoiceGroup
                                options={floors.filter((floor) => floor.id !== element.floorId).map((floor) => ({ id: floor.id, name: floor.name }))}
                                value={element.targetFloorId}
                                onChange={(nextId) => handleChange('targetFloorId', nextId)}
                            />
                        </div>
                        <div className="property-row stacked">
                            <label>Direction</label>
                            <select
                                value={element.direction}
                                onChange={(e) => handleChange('direction', e.target.value)}
                            >
                                <option value="north">North</option>
                                <option value="south">South</option>
                                <option value="east">East</option>
                                <option value="west">West</option>
                            </select>
                        </div>
                        <div className="property-row">
                            <label>Width</label>
                            <input
                                type="number"
                                min="1"
                                value={element.width}
                                onChange={(e) => handleChange('width', parseFloat(e.target.value) || 1)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Run</label>
                            <input
                                type="number"
                                min="2"
                                value={element.height}
                                onChange={(e) => handleChange('height', parseFloat(e.target.value) || 2)}
                            />
                        </div>
                    </>
                )}

                {type === 'wall' && (
                    <>
                        <div className="property-row">
                            <label>Start X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.startX}
                                onChange={(e) => handleChange('startX', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Start Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.startY}
                                onChange={(e) => handleChange('startY', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>End X</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.endX}
                                onChange={(e) => handleChange('endX', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>End Y</label>
                            <input
                                type="number"
                                step="0.01"
                                value={element.endY}
                                onChange={(e) => handleChange('endY', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="property-row">
                            <label>Thickness</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0.05"
                                value={element.thickness || 0.18}
                                onChange={(e) => handleChange('thickness', parseFloat(e.target.value) || 0.18)}
                            />
                        </div>
                    </>
                )}

                <button
                    className="delete-btn"
                    onClick={() => removeElement(id, type)}
                >
                    Delete {type}
                </button>
            </div>
        </div>
    );
}
