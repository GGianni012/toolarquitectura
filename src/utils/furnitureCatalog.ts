import type { FurnitureType } from '../store/useStore';

export interface FurniturePreset {
    type: FurnitureType;
    name: string;
    width: number;
    depth: number;
    height: number;
    color: string;
    category: 'living' | 'gastronomy';
}

export const FURNITURE_PRESETS: FurniturePreset[] = [
    { type: 'sofa', name: 'Sofa', width: 2, depth: 0.9, height: 0.75, color: '#ff8f7a', category: 'living' },
    { type: 'bed', name: 'Bed', width: 1.6, depth: 2, height: 0.55, color: '#8cc7ff', category: 'living' },
    { type: 'plant', name: 'Plant', width: 0.5, depth: 0.5, height: 1.2, color: '#63d37c', category: 'living' },
    { type: 'cinema_screen', name: 'Cinema Screen', width: 3.4, depth: 0.28, height: 2.1, color: '#f2f5f7', category: 'living' },
    { type: 'dining_table', name: 'Dining Table', width: 1.4, depth: 0.8, height: 0.76, color: '#d9b38c', category: 'gastronomy' },
    { type: 'round_table', name: 'Round Cafe Table', width: 1.1, depth: 1.1, height: 0.76, color: '#ceb08d', category: 'gastronomy' },
    { type: 'dining_chair', name: 'Dining Chair', width: 0.52, depth: 0.52, height: 0.92, color: '#7e8aa6', category: 'gastronomy' },
    { type: 'bar_stool', name: 'Bar Stool', width: 0.45, depth: 0.45, height: 0.78, color: '#a77c5a', category: 'gastronomy' },
    { type: 'booth_seat', name: 'Booth Seat', width: 1.8, depth: 0.75, height: 1.15, color: '#b65c5c', category: 'gastronomy' },
    { type: 'corner_booth', name: 'Corner Booth', width: 1.9, depth: 1.9, height: 1.15, color: '#ad5c62', category: 'gastronomy' },
    { type: 'service_counter', name: 'Service Counter', width: 2.2, depth: 0.8, height: 1.05, color: '#6a7387', category: 'gastronomy' },
    { type: 'host_stand', name: 'Host Stand', width: 1, depth: 0.55, height: 1.12, color: '#715e51', category: 'gastronomy' },
    { type: 'prep_table', name: 'Prep Table', width: 1.6, depth: 0.7, height: 0.9, color: '#b8c4cf', category: 'gastronomy' },
    { type: 'stove_range', name: 'Stove Range', width: 1.2, depth: 0.75, height: 0.95, color: '#5f6b77', category: 'gastronomy' },
    { type: 'fryer_station', name: 'Fryer Station', width: 0.95, depth: 0.75, height: 0.95, color: '#7a838e', category: 'gastronomy' },
    { type: 'oven_unit', name: 'Oven Unit', width: 1.2, depth: 0.8, height: 1.2, color: '#6c7381', category: 'gastronomy' },
    { type: 'double_sink', name: 'Double Sink', width: 1.4, depth: 0.7, height: 0.92, color: '#9eb6c2', category: 'gastronomy' },
    { type: 'fridge_display', name: 'Reach-in Fridge', width: 1.1, depth: 0.8, height: 2.1, color: '#dfe9ef', category: 'gastronomy' },
    { type: 'display_case', name: 'Display Case', width: 1.8, depth: 0.8, height: 1.25, color: '#8dc9d4', category: 'gastronomy' },
    { type: 'espresso_station', name: 'Espresso Station', width: 1.2, depth: 0.7, height: 1.05, color: '#4e5566', category: 'gastronomy' },
    { type: 'bakery_rack', name: 'Bakery Rack', width: 1.2, depth: 0.55, height: 2, color: '#bcc7d3', category: 'gastronomy' },
    { type: 'salad_bar', name: 'Salad Bar', width: 1.8, depth: 0.85, height: 1.35, color: '#9ec8bb', category: 'gastronomy' },
    { type: 'beer_tap', name: 'Beer Tap Bar', width: 1.4, depth: 0.75, height: 1.15, color: '#8b6d53', category: 'gastronomy' }
];

export function getFurniturePreset(type: FurnitureType) {
    return FURNITURE_PRESETS.find((preset) => preset.type === type) || FURNITURE_PRESETS[0];
}
