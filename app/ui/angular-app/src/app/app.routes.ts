import { Routes } from '@angular/router';
import { ChatComponent } from './chat/chat.component';
import { SettingsComponent } from './settings/settings.component';

export const routes: Routes = [
  { path: '', redirectTo: 'c/new', pathMatch: 'full' },
  { path: 'c/:chatId', component: ChatComponent },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'c/new' }
];
