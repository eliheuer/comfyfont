/**
 * theme.js — Design tokens for ComfyFont UI.
 *
 * All spacing, color, and sizing constants live here so every panel
 * and overlay can share the same visual language.
 */

// ---------------------------------------------------------------------------
// Spacing — one value controls all gaps: between panels, between cells,
// and the outer padding of every container. This gives a uniform bento-box
// rhythm throughout the UI.

export const GAP      = 6;   // px — used everywhere: cell gap, panel gap, edge padding
export const PANEL_R  = 8;   // px — border-radius for all panels and cells

// ---------------------------------------------------------------------------
// Colors — from Runebender theme.rs

export const T = {
  bg:            '#101010',
  panel:         '#1c1c1c',
  cellOutline:   '#606060',
  cellSelected:  '#66ee88',
  glyphFill:     '#a0a0a0',
  glyphSelected: '#66ee88',
  labelText:     '#808080',
  labelUnicode:  '#505050',
  labelSelected: '#66ee88',
  sidebarText:   '#808080',
  headerText:    '#606060',
  accent:        '#66ee88',
};

// ---------------------------------------------------------------------------
// Mark color palette — from Runebender theme.rs

export const MARK_COLORS = [
  { hex: '#FF5533', rgba: '1,0.333,0.2,1',       label: 'red'    },
  { hex: '#FF9911', rgba: '1,0.6,0.067,1',        label: 'orange' },
  { hex: '#CCDD00', rgba: '0.8,0.867,0,1',        label: 'yellow' },
  { hex: '#44DD44', rgba: '0.267,0.867,0.267,1',  label: 'green'  },
  { hex: '#00CCBB', rgba: '0,0.8,0.733,1',        label: 'teal'   },
  { hex: '#9944CC', rgba: '0.6,0.267,0.8,1',      label: 'purple' },
  { hex: '#CC44AA', rgba: '0.8,0.267,0.667,1',    label: 'pink'   },
];

// ---------------------------------------------------------------------------
// Glyph grid layout

export const CELL_W    = 128;  // base cell width (1-column span)
export const CELL_H    = 192;  // cell height
export const LABEL_H   = 52;   // label zone at bottom of each cell
export const SIDEBAR_W = 168;  // category sidebar width
export const INFO_W    = 168;  // glyph info panel width
