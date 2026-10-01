/* Le pont entre la page du boîtier et le processus principal. Trois gestes :
   fermer un téléphone, laisser passer les clics dans la marge transparente,
   et recevoir la teinte de la page et l'heure. Rien d'autre n'est exposé. */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telephone", {
  fermer: () => ipcRenderer.send("fermer"),
  traverser: (oui) => ipcRenderer.send("traverser", !!oui),
  surTeinte: (rappel) => ipcRenderer.on("teinte", (_e, teinte) => rappel(teinte)),
  surHeure: (rappel) => ipcRenderer.on("heure", (_e, iso) => rappel(iso)),
});
