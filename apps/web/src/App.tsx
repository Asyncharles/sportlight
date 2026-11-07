import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Navigate, Outlet, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { LiveTicker } from './components/LiveTicker';
import { Header } from './components/Header';
import { Admin } from './features/admin/Admin';
import { BestOfToday } from './features/highlights/BestOfToday';
import { HighlightViewer } from './features/highlights/HighlightViewer';
import { Landing } from './features/landing/Landing';
import { LivePage } from './features/live/LivePage';
import { Settings } from './features/settings/Settings';
import { SportsSettings } from './features/settings/SportsSettings';
import { routerMode } from './lib/env';
import { HighlightsProvider } from './lib/highlights';
import { live } from './lib/live-client';
import { useApplyAppearance } from './lib/preferences';

const Router = routerMode === 'hash' ? HashRouter : BrowserRouter;

export function App() {
  useApplyAppearance();
  useEffect(() => live.start(), []);

  return (
    <HighlightsProvider>
      <Router>
        <Routes>
          <Route index element={<Landing />} />
          <Route element={<Shell />}>
            <Route path="live" element={<LivePage />} />
            <Route path="best" element={<BestOfToday />} />
            <Route path="best/:id" element={<HighlightViewer />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/sports" element={<SportsSettings />} />
            <Route path="dashboard" element={<LegacyContentRedirect />} />
            <Route path="admin" element={<Admin />} />
            <Route path="admin/*" element={<Navigate to="/admin" replace />} />
          </Route>
          {/* Old onboarding URLs: the sports choice now happens in the live page tour. */}
          <Route path="welcome/*" element={<Navigate to="/live" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </HighlightsProvider>
  );
}

function Shell() {
  // Both the live and 3D views share the live route.
  const ticker = Boolean(useMatch({ path: '/live', end: true }));
  return (
    <div className="app-shell" data-ticker={ticker}>
      <a href="#content" className="sr-only">
        Skip to content
      </a>
      <div className="app-top">
        <Header />
        {ticker && <LiveTicker />}
      </div>
      <div id="content">
        <Outlet />
      </div>
    </div>
  );
}

function LegacyContentRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/admin', search, hash }} replace />;
}
