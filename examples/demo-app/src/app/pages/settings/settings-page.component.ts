import { Component } from '@angular/core';

// A route-mounted page that composes no child components → the tool marks it
// 🟦 "isolated page" (normal — it has no parent component by design).
@Component({
  selector: 'app-settings-page',
  standalone: true,
  template: `<h1>Settings</h1>`,
})
export class SettingsPageComponent {}
