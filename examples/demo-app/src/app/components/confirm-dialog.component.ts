import { Component, inject } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  template: `
    <p>Are you sure?</p>
    <button (click)="ref.close(true)">Confirm</button>
    <button (click)="ref.close(false)">Cancel</button>
  `,
})
export class ConfirmDialogComponent {
  ref = inject<DialogRef<boolean>>(DialogRef);
}
