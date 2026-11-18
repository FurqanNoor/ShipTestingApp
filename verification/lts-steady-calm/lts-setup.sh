#!/bin/bash
# Build steady-state (local time stepping) variants of a finished transient calm case and submit them.
# usage: bash -s <src_run_dir_name> <tag> <maxCo> <maxAlphaCo> <iters> <cores>
set -e
R=/scratch/project_2022733/fnoor/hulltests
SRC=$R/runs/$1; TAG=$2; CO=$3; ACO=$4; IT=$5; NP=$6
D=$R/lts/$1-$TAG
rm -rf "$D"; mkdir -p "$D"
cp -r "$SRC/constant" "$SRC/system" "$SRC/0" "$D/"
cd "$D"
rm -f system/decomposeParDict
# Time scheme: local Euler (per-cell pseudo time step).
sed -i 's/ddtSchemes { default Euler; }/ddtSchemes { default localEuler; }/' system/fvSchemes
grep -q localEuler system/fvSchemes
# PIMPLE: LTS controls as in the OpenFOAM DTCHull tutorial.
python3 - "$CO" "$ACO" <<'PY' 2>/dev/null || perl -0pi -e "s/PIMPLE\s*\{[^}]*\}/PIMPLE\n{\n    momentumPredictor no; nOuterCorrectors 1; nCorrectors 2; nNonOrthogonalCorrectors 1;\n    pRefCell 0; pRefValue 0;\n    maxCo $CO; maxAlphaCo $ACO; rDeltaTSmoothingCoeff 0.05; rDeltaTDampingCoeff 0.5;\n    nAlphaSpreadIter 0; nAlphaSweepIter 0; maxDeltaT 1;\n}/s" system/fvSolution
import sys,re
co,aco=sys.argv[1],sys.argv[2]
t=open('system/fvSolution').read()
t=re.sub(r'PIMPLE\s*\{[^}]*\}',f'PIMPLE\n{{\n    momentumPredictor no; nOuterCorrectors 1; nCorrectors 2; nNonOrthogonalCorrectors 1;\n    pRefCell 0; pRefValue 0;\n    maxCo {co}; maxAlphaCo {aco}; rDeltaTSmoothingCoeff 0.05; rDeltaTDampingCoeff 0.5;\n    nAlphaSpreadIter 0; nAlphaSweepIter 0; maxDeltaT 1;\n}}',t,flags=re.S)
open('system/fvSolution','w').write(t)
PY
grep -q rDeltaTSmoothingCoeff system/fvSolution
sed -i -E "s/^endTime .*/endTime $IT;/; s/^deltaT .*/deltaT 1;/; s/^writeInterval .*/writeInterval $IT;/; s/^writeControl .*/writeControl timeStep;/; s/^adjustTimeStep .*/adjustTimeStep no;/" system/controlDict
printf 'FoamFile\n{\n    version 2.0;\n    format ascii;\n    class dictionary;\n    object decomposeParDict;\n}\nnumberOfSubdomains %s;\nmethod scotch;\n' "$NP" > system/decomposeParDict
cat > job.sh <<EOF
#!/bin/bash
#SBATCH --job-name=lts-$TAG
#SBATCH --account=project_2022733
#SBATCH --partition=small
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=$NP
#SBATCH --time=03:00:00
#SBATCH --output=slurm.log
cd "\$SLURM_SUBMIT_DIR"
apptainer exec --cleanenv --bind "\$PWD:/case" --pwd /case $R/openfoam-v2312.sif bash -c 'source /usr/lib/openfoam/openfoam2312/etc/bashrc 2>/dev/null || source /opt/openfoam2312/etc/bashrc; decomposePar -force > log.decomposePar 2>&1 && export OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 OMPI_MCA_btl_vader_single_copy_mechanism=none; mpirun --oversubscribe --bind-to none -np $NP interFoam -parallel > log.interFoam 2>&1'
echo "EXIT \$?"
rm -rf processor*
EOF
sbatch --parsable job.sh
