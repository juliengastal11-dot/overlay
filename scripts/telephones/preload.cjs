/* Le pont entre la page du boîtier et le processus principal. Les gestes :
   fermer un téléphone, le déplacer par sa poignée, laisser passer les clics
   dans la marge transparente ; et ce qui arrive : la teinte de la page, l'heure,
   une nouvelle géométrie quand il change d'écran. Rien d'autre n'est exposé. */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telephone", {
  fermer: () => ipcRenderer.send("fermer"),
  traverser: (oui) => ipcRenderer.send("traverser", !!oui),
  glisserDebut: () => ipcRenderer.send("glisser-debut"),
  glisser: () => ipcRenderer.send("glisser"),
  glisserFin: () => ipcRenderer.send("glisser-fin"),
  surTeinte: (rappel) => ipcRenderer.on("teinte", (_e, teinte) => rappel(teinte)),
  surHeure: (rappel) => ipcRenderer.on("heure", (_e, iso) => rappel(iso)),
  surGeometrie: (rappel) => ipcRenderer.on("geometrie", (_e, G) => rappel(G)),
});
