import { useMemo, useSyncExternalStore } from 'react';
import { projectDotColor } from '../lib/useProjectIndicators';
import { villageCamera } from '../scene/cameraController';
import { DEFAULT_VIEW } from '../scene/defaultView';
import { MINIMAP_VIEWBOX, groundFootprint, minimapDots, worldToMinimap } from '../scene/minimapMath';
import { useWorldStore } from '../store/worldStore';
import { VillageNavigationCard } from './VillageNavigationCard';

/** Each Project's minimap dot, coloured like its status dot in the village and the cards view. */
function useDots() {
  const projects = useWorldStore((s) => s.projects);
  const lastTaskIdByProject = useWorldStore((s) => s.lastTaskIdByProject);
  const tasksById = useWorldStore((s) => s.tasksById);
  const reviewedTaskIds = useWorldStore((s) => s.reviewedTaskIds);
  const notificationsById = useWorldStore((s) => s.notificationsById);
  return useMemo(() => {
    const state = { lastTaskIdByProject, tasksById, reviewedTaskIds, notificationsById };
    return minimapDots(projects, (project) => projectDotColor(project, state));
  }, [projects, lastTaskIdByProject, tasksById, reviewedTaskIds, notificationsById]);
}

/** The navigation card wired to the village camera; part of the lazy-loaded 3D view. */
export function VillageNavigation() {
  const camera = useSyncExternalStore(villageCamera.subscribe, villageCamera.getSnapshot, villageCamera.getSnapshot);
  const dots = useDots();
  const footprint = useMemo(
    () => groundFootprint(camera.orbit, camera.aspect, DEFAULT_VIEW.fov).map((point) => worldToMinimap(point, MINIMAP_VIEWBOX)),
    [camera.orbit, camera.aspect],
  );
  return (
    <VillageNavigationCard
      disabled={!camera.enabled}
      dots={dots}
      footprint={footprint}
      target={worldToMinimap(camera.orbit.target, MINIMAP_VIEWBOX)}
      onHome={() => villageCamera.goHome()}
      onPick={(point, mode) => (mode === 'fly' ? villageCamera.flyToPoint(point) : villageCamera.moveToPoint(point))}
      onKey={(key) => villageCamera.panByKey(key)}
    />
  );
}
