/** Plain-language explanations for common failures. The raw error and logs are always kept as well. */
const HINTS=[
  {test:/non-positive transverse GM|no stable free-motion start|capsiz/i,
    title:'Stability failure: capsizes under the standard load',
    verdict:'stability-failure',
    hint:'With the competition load rule (half the test mass as low ballast, half spread over the hull) this hull has no upright stable floating position: it would capsize. This is recorded as a stability failure for this load, not an app error.'},
  {test:/reaches or exceeds (open-rim|the hull envelope) displacement|No (dry upright|surface-floating) initial condition/i,
    title:'Hull cannot float this load',
    verdict:'sinks',
    hint:'At this test mass the hull would sink or flood. The technical detail shows the most this hull can carry. If every load fails, check the STL: wrong units make a model 10x or 25x too small, and an open hull upside down (deck down) floods at once; use Flip / Roll 90° in the workbench. Otherwise the hull is genuinely too small or shallow for this load: untick it, or make the hull deeper/wider.'},
  {test:/is not inside the mesh|locationInMesh|Stage (blockMesh|snappyHexMesh|surfaceFeatureExtract|topoSet|setFields|decomposePar) failed/i,
    title:'Meshing step failed',
    hint:'OpenFOAM could not build the mesh for this case (see the stage named in the log). If it repeats for a clean STL, it is an app bug: send the downloaded case.'},
  {test:/Mesh quality checks did not pass/i,
    title:'Mesh failed the quality check',
    hint:'OpenFOAM could not build a clean mesh around this hull, so it stopped instead of solving on a bad mesh. Very thin walls, tiny gaps or self-intersecting/overlapping surfaces are the usual cause; repair and re-export the STL. Details are in log.checkMesh in the downloaded case.'},
  {test:/(wave grid|wave background alone) requires|exceeds the maximum mesh-cell budget|cell budget/i,
    title:'Mesh too large for the cell budget',
    hint:'This test needs more mesh cells than allowed for one case. Use Quick mode, or run it on a larger workstation with a raised budget.'},
  {test:/exit 137|out of memory|OOMKilled|Killed\b|std::bad_alloc/i,
    title:'Ran out of memory',
    hint:'Docker stopped the solver for using too much RAM. Raise the memory limit (CFD_MEMORY=24g npm run cfd) and Docker Desktop\'s memory setting, or use fewer cores for this run.'},
  {test:/time limit was reached|Stopped at time limit/i,
    title:'Hit the time limit',
    hint:'The run took longer than the configured limit. Raise it with CFD_TIMEOUT_MS (up to 24 hours), or use Quick mode.'},
  {test:/Floating point exception|sigFpe|\bnan\b|Maximum number of iterations exceeded/i,
    title:'Solver became unstable',
    hint:'The flow solution blew up. This usually means a bad mesh near the hull or a time step too large for violent motion. Check the hull geometry; if it repeats, report it with the downloaded case.'},
  {test:/Cannot connect to the Docker daemon|docker.*not (found|running)|image or Docker daemon is unavailable/i,
    title:'Docker is not running',
    hint:'Start Docker Desktop, wait until it says it is running, then try again.'},
  {test:/no space left on device|ENOSPC/i,
    title:'Disk is full',
    hint:'Free disk space (old runs live in the cfd-runs folder) and run again.'},
  {test:/self-intersect|surface is not closed|open edges|non-manifold|not watertight/i,
    title:'STL surface problem',
    hint:'The STL is not a clean closed surface (holes, overlaps or self-intersections). Repair it in your CAD tool or Meshmixer/Netfabb and export again.'},
  {test:/Local service restarted|Interrupted by service restart/i,
    title:'Interrupted by a restart',
    hint:'The app was restarted while this was running. Use "Re-run unfinished tests" to run it again.'},
];

/** @returns {{title:string,hint:string}|null} */
export function explainFailure(...texts){
  const text=texts.filter(Boolean).map(t=>Array.isArray(t)?t.join('\n'):String(t)).join('\n');
  if(!text)return null;
  for(const h of HINTS)if(h.test.test(text))return {title:h.title,hint:h.hint,...(h.verdict?{verdict:h.verdict}:{})};
  return null;
}
