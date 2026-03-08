import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Mode = '2D' | '3D';
export type ElementType = 'room' | 'furniture' | 'wall' | 'door' | 'cylinder' | 'surface' | 'stair';
export type OpenSide = 'north' | 'south' | 'east' | 'west' | 'none';
export type RoomEdge = Exclude<OpenSide, 'none'>;
export type StairDirection = Exclude<OpenSide, 'none'>;
export type DoorHostKind = 'wall' | 'room';

export interface BaseElement {
    id: string;
    locked?: boolean;
    color?: string;
    name?: string;
}

export interface Floor {
    id: string;
    name: string;
    elevation: number;
    height: number;
    visible: boolean;
    openSide: OpenSide;
    reference?: FloorReference | null;
}

export interface FloorReference {
    id: string;
    name: string;
    src: string;
    kind: 'image' | 'pdf';
    opacity: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    locked: boolean;
}

export interface PositionedElement extends BaseElement {
    floorId: string;
}

export interface Room extends PositionedElement {
    x: number;
    y: number;
    width: number;
    height: number;
    wallHeight?: number;
}

export interface Cylinder extends PositionedElement {
    x: number;
    y: number;
    radius: number;
    wallHeight?: number;
}

export interface Surface extends PositionedElement {
    points: { x: number, y: number }[];
    altitude?: number;
    depth?: number;
}

export interface Furniture extends PositionedElement {
    type: 'sofa' | 'bed' | 'plant';
    roomId?: string;
    x: number;
    y: number;
    rotation: number;
    width?: number;
    depth?: number;
    height?: number;
    altitude?: number;
}

export interface Wall extends PositionedElement {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    wallHeight?: number;
    thickness?: number;
}

export interface Door extends PositionedElement {
    hostKind?: DoorHostKind;
    wallId?: string;
    roomId?: string;
    edge?: RoomEdge;
    ratio: number; // Position along the wall 0.0 to 1.0
    width: number;
    doorHeight: number;
}

export interface Stair extends PositionedElement {
    x: number;
    y: number;
    width: number;
    height: number;
    targetFloorId: string;
    direction: StairDirection;
}

export type InteractMode = 'select' | 'draw_wall' | 'draw_surface' | 'place_door' | 'place_cylinder';

interface AppState {
    mode: Mode;
    interactMode: InteractMode;
    selectedElement: { id: string, type: ElementType } | null;
    floors: Floor[];
    activeFloorId: string;

    rooms: Room[];
    furniture: Furniture[];
    walls: Wall[];
    doors: Door[];
    cylinders: Cylinder[];
    surfaces: Surface[];
    stairs: Stair[];

    setMode: (mode: Mode) => void;
    setInteractMode: (mode: InteractMode) => void;
    toggleMode: () => void;
    setSelectedElement: (element: { id: string, type: ElementType } | null) => void;
    setActiveFloor: (floorId: string) => void;

    addFloor: (floor?: Partial<Omit<Floor, 'id'>>) => void;
    updateFloor: (id: string, data: Partial<Floor>) => void;

    addRoom: (room: Omit<Room, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateRoom: (id: string, data: Partial<Room>) => void;

    addFurniture: (item: Omit<Furniture, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateFurniture: (id: string, data: Partial<Furniture>) => void;

    addWall: (wall: Omit<Wall, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateWall: (id: string, data: Partial<Wall>) => void;

    addDoor: (door: Omit<Door, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateDoor: (id: string, data: Partial<Door>) => void;

    addCylinder: (cylinder: Omit<Cylinder, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateCylinder: (id: string, data: Partial<Cylinder>) => void;

    addSurface: (surface: Omit<Surface, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateSurface: (id: string, data: Partial<Surface>) => void;

    addStair: (stair: Omit<Stair, 'id' | 'floorId'> & { floorId?: string }) => void;
    updateStair: (id: string, data: Partial<Stair>) => void;

    removeElement: (id: string, type: ElementType) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 9);
const initialFloorId = 'floor-1';
const initialFloors: Floor[] = [
    { id: initialFloorId, name: 'Ground Floor', elevation: 0, height: 3.2, visible: true, openSide: 'south', reference: null }
];

export const useStore = create<AppState>()(persist((set) => ({
    mode: '2D',
    interactMode: 'select',
    selectedElement: null,
    floors: initialFloors,
    activeFloorId: initialFloorId,

    rooms: [
        { id: '1', floorId: initialFloorId, x: 2, y: 2, width: 4, height: 3, name: 'Living Room', color: '#88ccff', wallHeight: 3 }
    ],
    furniture: [
        { id: 'f1', floorId: initialFloorId, type: 'sofa', x: 3, y: 3, rotation: 0 }
    ],
    walls: [],
    doors: [],
    cylinders: [],
    surfaces: [],
    stairs: [],

    setMode: (mode) => set({ mode }),
    setInteractMode: (mode) => set({ interactMode: mode }),
    toggleMode: () => set((state) => ({ mode: state.mode === '2D' ? '3D' : '2D' })),
    setSelectedElement: (element) => set({ selectedElement: element }),
    setActiveFloor: (activeFloorId) => set({ activeFloorId, selectedElement: null }),

    addFloor: (floor) => set((state) => {
        const highestFloor = state.floors.reduce((currentHighest, currentFloor) => {
            if (!currentHighest) return currentFloor;
            return currentFloor.elevation + currentFloor.height > currentHighest.elevation + currentHighest.height
                ? currentFloor
                : currentHighest;
        }, state.floors[0]);

        const newFloor: Floor = {
            id: generateId(),
            name: floor?.name || `Floor ${state.floors.length + 1}`,
            elevation: floor?.elevation ?? highestFloor.elevation + highestFloor.height,
            height: floor?.height ?? highestFloor.height,
            visible: floor?.visible ?? true,
            openSide: floor?.openSide ?? highestFloor.openSide ?? 'south',
            reference: floor?.reference ?? null
        };

        return {
            floors: [...state.floors, newFloor],
            activeFloorId: newFloor.id,
            selectedElement: null
        };
    }),
    updateFloor: (id, data) => set((state) => ({
        floors: state.floors.map((floor) => floor.id === id ? { ...floor, ...data } : floor)
    })),

    addRoom: (room) => set((state) => ({
        rooms: [...state.rooms, { ...room, floorId: room.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateRoom: (id, data) => set((state) => ({
        rooms: state.rooms.map(r => r.id === id ? { ...r, ...data } : r),
        doors: data.floorId
            ? state.doors.map((door) => door.roomId === id ? { ...door, floorId: data.floorId as string } : door)
            : state.doors
    })),

    addFurniture: (item) => set((state) => ({
        furniture: [...state.furniture, { ...item, floorId: item.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateFurniture: (id, data) => set((state) => ({
        furniture: state.furniture.map(f => f.id === id ? { ...f, ...data } : f)
    })),

    addWall: (wall) => set((state) => ({
        walls: [...state.walls, { ...wall, floorId: wall.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateWall: (id, data) => set((state) => ({
        walls: state.walls.map(w => w.id === id ? { ...w, ...data } : w),
        doors: data.floorId
            ? state.doors.map((door) => door.wallId === id ? { ...door, floorId: data.floorId as string } : door)
            : state.doors
    })),

    addDoor: (door) => set((state) => {
        const parentWall = door.wallId ? state.walls.find((wall) => wall.id === door.wallId) : null;
        const parentRoom = door.roomId ? state.rooms.find((room) => room.id === door.roomId) : null;
        const hostKind: DoorHostKind = door.hostKind || (door.roomId ? 'room' : 'wall');
        return {
            doors: [
                ...state.doors,
                {
                    ...door,
                    hostKind,
                    floorId: door.floorId || parentWall?.floorId || parentRoom?.floorId || state.activeFloorId,
                    id: generateId()
                }
            ]
        };
    }),
    updateDoor: (id, data) => set((state) => ({
        doors: state.doors.map(d => d.id === id ? { ...d, ...data } : d)
    })),

    addCylinder: (cylinder) => set((state) => ({
        cylinders: [...state.cylinders, { ...cylinder, floorId: cylinder.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateCylinder: (id, data) => set((state) => ({
        cylinders: state.cylinders.map(c => c.id === id ? { ...c, ...data } : c)
    })),

    addSurface: (surface) => set((state) => ({
        surfaces: [...state.surfaces, { ...surface, floorId: surface.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateSurface: (id, data) => set((state) => ({
        surfaces: state.surfaces.map(s => s.id === id ? { ...s, ...data } : s)
    })),

    addStair: (stair) => set((state) => ({
        stairs: [...state.stairs, { ...stair, floorId: stair.floorId || state.activeFloorId, id: generateId() }]
    })),
    updateStair: (id, data) => set((state) => ({
        stairs: state.stairs.map(s => s.id === id ? { ...s, ...data } : s)
    })),

    removeElement: (id, type) => set((state) => {
        const nextState = { ...state };
        if (state.selectedElement?.id === id) {
            nextState.selectedElement = null;
        }
        switch (type) {
            case 'room':
                nextState.rooms = state.rooms.filter(i => i.id !== id);
                nextState.doors = state.doors.filter((door) => door.roomId !== id);
                break;
            case 'furniture': nextState.furniture = state.furniture.filter(i => i.id !== id); break;
            case 'wall':
                nextState.walls = state.walls.filter(i => i.id !== id);
                nextState.doors = state.doors.filter((door) => door.wallId !== id);
                break;
            case 'door': nextState.doors = state.doors.filter(i => i.id !== id); break;
            case 'cylinder': nextState.cylinders = state.cylinders.filter(i => i.id !== id); break;
            case 'surface': nextState.surfaces = state.surfaces.filter(i => i.id !== id); break;
            case 'stair': nextState.stairs = state.stairs.filter(i => i.id !== id); break;
        }
        return nextState;
    })
}), {
    name: 'floor-planner-state',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({
        mode: state.mode,
        floors: state.floors,
        activeFloorId: state.activeFloorId,
        rooms: state.rooms,
        furniture: state.furniture,
        walls: state.walls,
        doors: state.doors,
        cylinders: state.cylinders,
        surfaces: state.surfaces,
        stairs: state.stairs
    })
}));
