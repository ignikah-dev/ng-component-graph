import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterLink, RouterOutlet],
  template: `<a routerLink="/">Home</a><a routerLink="/about">About</a><router-outlet></router-outlet>`,
})
export class AppComponent {}
