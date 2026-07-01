import { Routes } from '@angular/router';
import { HomePageComponent } from '@app/pages/home';

export const appRoutes: Routes = [
  { path: 'about', loadComponent: () => import('@app/pages/about/about-page.component').then(m => m.AboutPageComponent) },
  { path: '', component: HomePageComponent },
];
