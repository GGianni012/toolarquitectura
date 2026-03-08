import { useStore } from '../store/useStore';
import { Lock, Unlock, X } from 'lucide-react';
import './PropertiesPanel.css';

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

    const activeFloor = floors.find((floor) => floor.id === activeFloorId);

    if (!selectedElement) {
        if (!activeFloor) return null;

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
            <div className="properties-panel">
                <div className="properties-header">
                    <h3>{activeFloor.name} Settings</h3>
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

    return (
        <div className="properties-panel">
            <div className="properties-header">
                <h3>{element.name || type.charAt(0).toUpperCase() + type.slice(1)} Properties</h3>
                <button className="icon-btn" onClick={() => setSelectedElement(null)}>
                    <X size={18} />
                </button>
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
                        <select
                            value={element.floorId}
                            onChange={(e) => handleChange('floorId', e.target.value)}
                        >
                            {floors.map((floor) => (
                                <option key={floor.id} value={floor.id}>
                                    {floor.name}
                                </option>
                            ))}
                        </select>
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
                )}

                {/* Altitude for Furniture */}
                {type === 'furniture' && (
                    <>
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
                        <div className="property-row stacked">
                            <label>Target Level</label>
                            <select
                                value={element.targetFloorId}
                                onChange={(e) => handleChange('targetFloorId', e.target.value)}
                            >
                                {floors.filter((floor) => floor.id !== element.floorId).map((floor) => (
                                    <option key={floor.id} value={floor.id}>
                                        {floor.name}
                                    </option>
                                ))}
                            </select>
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
