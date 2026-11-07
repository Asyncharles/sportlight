import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Header } from './components/Header';
import { Admin } from './features/admin/Admin';
import { BestOfToday } from './features/highlights/BestOfToday';
import { HighlightViewer } from './features/highlights/HighlightViewer';
import { LivePage } from './features/live/LivePage';
import { ChooseSports, Welcome } from './features/onboarding/Welcome';
import { Settings } from './features/settings/Settings';
import { routerMode } from './lib/env';
import { HighlightsProvider } from './lib/highlights';
import { live } from './lib/live-client';
import { useApplyAppearance, usePreferences } from './lib/preferences';

const Router = routerMode === 'hash' ? HashRouter : BrowserRouter;

export function App() {
  useApplyAppearance();
  useEffect(() => live.start(), []);

  return (
    <HighlightsProvider>
      <Router>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/welcome/sports" element={<ChooseSports />} />
          <Route element={<Shell />}>
            <Route
              index
              element={
                <RequireOnboarding>
                  <LivePage />
                </RequireOnboarding>
              }
            />
            <Route
              path="best"
              element={
                <RequireOnboarding>
                  <BestOfToday />
                </RequireOnboarding>
              }
            />
            <Route
              path="best/:id"
              element={
                <RequireOnboarding>
                  <HighlightViewer />
                </RequireOnboarding>
              }
            />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </HighlightsProvider>
  );
}

function Shell() {
  return (
    <>
      <a href="#content" className="sr-only">
        Skip to content
      </a>
      <Header />
      <div id="content">
        <Outlet />
      </div>
    </>
  );
}

function RequireOnboarding({ children }: { children: ReactNode }) {
  const { prefs } = usePreferences();
  return prefs.onboarded ? <>{children}</> : <Navigate to="/welcome" replace />;
}
