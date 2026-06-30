import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./pages/dashboard/dashboard-page.component').then(m => m.DashboardPageComponent),
  },
  {
    path: 'orders',
    loadComponent: () =>
      import('./pages/orders/order-list-page.component').then(m => m.OrderListPageComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./pages/settings/settings-page.component').then(m => m.SettingsPageComponent),
  },
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
];
