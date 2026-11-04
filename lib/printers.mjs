/**
 * Printer profiles, so a 3MF can carry its filament colors.
 *
 * OrcaSlicer-based slicers only read filament colors from `Metadata/project_settings.config`
 * (`filament_colour`). That file makes the 3MF open as a *project*, which is layered over
 * factory defaults, so a config holding only our keys would wipe the printer's settings.
 * Naming real system presets (with nothing listed in `different_settings_to_system`) makes the
 * slicer load and select those presets instead. So colors can only be embedded safely when
 * the preset names are known: hence explicit profiles. (Approach from switch-tools'
 * nx-archive 3MF export.)
 */

export const PRINTERS = {
  // Preset names from Snapmaker Orca's resources/profiles/Snapmaker/{machine,process,filament}.
  // Printable area X 0.5-270.5, Y 1-271.
  'snapmaker-u1': {
    label: 'Snapmaker U1 (0.4 nozzle)',
    printer: 'Snapmaker U1 (0.4 nozzle)',
    process: '0.20mm Standard @Snapmaker U1 (0.4 nozzle)',
    filament: 'Snapmaker PLA Basic @U1',
    bedType: 'Textured PEI Plate',
    bedCenter: [135.5, 136],
    toolheads: 4,
  },
};

/** `Metadata/project_settings.config` selecting the profile's stock presets with these colors. */
export function projectSettings(profile, filamentColors) {
  return JSON.stringify(
    {
      printer_settings_id: profile.printer,
      print_settings_id: profile.process,
      filament_settings_id: filamentColors.map(() => profile.filament),
      // [process, filament 1..N, printer]
      different_settings_to_system: Array.from({ length: filamentColors.length + 2 }, () => ''),
      filament_colour: filamentColors.map((c) => c.toUpperCase()),
      curr_bed_type: profile.bedType,
    },
    null,
    4,
  );
}
