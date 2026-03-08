import { useStore } from './store/useStore';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Canvas2D from './components/2d/Canvas2D';
import Canvas3D from './components/3d/Canvas3D';
import PropertiesPanel from './components/PropertiesPanel';
import ControlsGuide from './components/ControlsGuide';
import './App.css';

function App() {
    const { mode } = useStore();

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
