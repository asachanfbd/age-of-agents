import { lazy, Suspense, useEffect } from 'react';
import { TopBar } from './ui/TopBar';
import { ProjectWorkspaceModal } from './ui/ProjectWorkspaceModal';
import { CatalogModal } from './ui/CatalogModal';
import { NotificationToasts } from './ui/NotificationToasts';
import { TaskSounds } from './ui/TaskSounds';
import { NotificationCenter } from './ui/NotificationCenter';
import { AppUpdateReloadBanner } from './ui/AppUpdateReloadBanner';
import { AppReconnectBanner } from './ui/AppReconnectBanner';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { useWorldStore } from './store/worldStore';
import { ProjectCardsView } from './ui/ProjectCardsView';
import { StatusFooter } from './ui/StatusFooter';
import { AgentAnalyticsDialog } from './ui/analytics/AgentAnalyticsDialog';
import { FooterCommandLog } from './ui/FooterCommandLog';
import { STATUS_FOOTER_HEIGHT } from './lib/statusFooter';

const WorldView = lazy(() => import('./ui/WorldView'));

export default function App() {
  const loadProjects = useWorldStore((s) => s.loadProjects);
  const loadExecutors = useWorldStore((s) => s.loadExecutors);
  const loadNotifications = useWorldStore((s) => s.loadNotifications);
  const loadAppUpdate = useWorldStore((s) => s.loadAppUpdate);
  const connectLiveUpdates = useWorldStore((s) => s.connectLiveUpdates);
  const viewMode = useWorldStore((s) => s.viewMode);

  useEffect(() => {
    void loadProjects();
    void loadExecutors();
    void loadNotifications();
    void loadAppUpdate();
    // The daemon is not session-bound (docs/architecture.md) — reconnecting picks up whatever
    // happened while this tab was closed via the next loadProjects, not this live subscription.
    const disconnect = connectLiveUpdates();
    const timer = setInterval(() => { void loadExecutors(); }, 30_000);
    return () => { clearInterval(timer); disconnect(); };
  }, [loadProjects, loadExecutors, loadNotifications, loadAppUpdate, connectLiveUpdates]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="app">
        {viewMode === 'world' ? (
          <Suspense fallback={null}>
            <WorldView />
          </Suspense>
        ) : (
          <ProjectCardsView />
        )}
        <TopBar />
        <AppUpdateReloadBanner />
        <AppReconnectBanner />
        <StatusFooter />
        <ProjectWorkspaceModal />
        <CatalogModal />
        <NotificationCenter />
        <FooterCommandLog />
        <AgentAnalyticsDialog />
        <NotificationToasts />
        <TaskSounds />
        <Toaster
          position="bottom-left"
          offset={{ bottom: STATUS_FOOTER_HEIGHT + 20, left: 24 }}
          mobileOffset={{ bottom: STATUS_FOOTER_HEIGHT + 12, left: 12, right: 12 }}
        />
      </div>
    </TooltipProvider>
  );
}
