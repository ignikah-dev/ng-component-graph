import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav>
      <a routerLink="/dashboard">Dashboard</a>
      <a routerLink="/orders">Orders</a>
      <!-- note: no link to /settings on purpose → nav-audit flags it as an orphan route -->
    </nav>
    <router-outlet />
  `,
})
export class AppComponent {}
