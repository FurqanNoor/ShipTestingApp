# Running tests on CSC Roihu (or any Slurm cluster)

The app can send every test to a supercomputer instead of running them one after another on your computer. On the cluster, each test, and each Full-mode check, runs at the same time on its own compute node. Several hulls can also run side by side.

The results are identical to a local run:
- the same pinned OpenFOAM v2312 image runs, through Apptainer;
- your computer still plans every case and reads every result;
- the tables, checks and Excel export are the same.

## One-time setup (about 10 minutes, plus the solver download)

1. **Create an SSH key on this computer.** Open a terminal (PowerShell on Windows), run the command below, and press Enter at every question. An empty passphrase lets the app connect without asking you every time.
   ```
   ssh-keygen -t ed25519
   ```
2. **Add the public key to your CSC account.** Go to MyCSC (my.csc.fi), then *Profile → SSH public keys → Add key*, and paste the contents of `C:\Users\<you>\.ssh\id_ed25519.pub`. Also check that your project lists **Roihu** under *Services*.
3. **Download the SSH certificate (Roihu only, every 24 hours).** Roihu accepts the key only together with a signed certificate that expires after 24 hours. In MyCSC go to *Profile → SSH public keys*, click **⋮** next to your key, and choose **Sign and download SSH certificate**. Save the file as `C:\Users\<you>\.ssh\id_ed25519-cert.pub` (same folder as the key, exactly that name; replace yesterday's file). SSH picks it up automatically. The app shows how many hours the certificate has left, and warns you before submitting if it has expired.
   Jobs already running on Roihu are not affected when the certificate expires. The app keeps retrying the live log and the result download, and continues as soon as you save a new certificate.
4. **Check that it works.** In a terminal, this should log in without a password:
   ```
   ssh <username>@roihu-cpu.csc.fi
   ```
   Answer `yes` to the first host-key question, then type `exit`.
5. **Fill in the app.** In the app, open **Test your hull**, choose **Run on: Cluster (CSC Roihu)** and open **Cluster settings**:

   | Setting | What to enter |
   | --- | --- |
   | Host | `roihu-cpu.csc.fi` (the CPU side of Roihu) |
   | CSC username | Your CSC username |
   | Project (billing) | Your project, e.g. `project_2001234` (shown in MyCSC) |
   | Partition | `small` (one shared node, up to 72 h, up to 384 cores). `test` (15 min) is only for a quick trial. **Test connection** lists the partitions with their time limits. |
   | Folder on the cluster | A folder in your project's scratch space, e.g. `/scratch/project_2001234/hulltests` |
   | Cores per test | 64 (the default). Measured on Roihu for a Quick calm test (131k cells): 16 cores 4.9 min, 32 cores 3.5–4.4 min, 64 cores 2.7 min, 128 cores 3.1 min. Keep the same value for every hull: the calm drag can differ slightly with the core count. |
   | Max hours per run | The upper bound for a job's Slurm time limit (72 h on `small`). Each job actually asks for about 2× its predicted run time plus 45 minutes (at least 1 h). Shorter limits let Slurm fit jobs into gaps (backfill): on 18 Nov 2026, 192-core jobs with a flat 24 h limit waited until 07:00; with 3 h they started within the hour. |
   | Memory per run | 0 uses the partition's default. Raise it only if a run fails with "out of memory". |
   | Hulls at once | How many hulls run side by side. Each Quick hull uses up to 9 jobs at once; each Full hull up to 15 (fewer when it can reuse finished Quick runs, see below). |

6. Press **Save**, then **Test connection**. It checks SSH, Slurm, Apptainer and the folder.
7. Press **Install solver** once. This downloads the OpenFOAM image into your cluster folder (about 700 MB, usually 5–20 minutes).

## Daily use

1. Choose **Cluster (CSC Roihu)**.
2. Tick the tests and press **Run tests**, or **Queue for all hulls**. The app uploads each case, submits it with `sbatch`, shows the live log and progress, and downloads the results when each job finishes.
3. You can close the test window, but **keep the app (`npm run cfd`) running** until the tests finish, because it fetches the results.
4. **Stop** cancels the cluster jobs (`scancel`). Closing or restarting the app does **not** cancel them: they keep running on the cluster, and the app re-attaches to them when it starts again and collects the results. Tests that had not been submitted yet when the app closed are marked interrupted; use **Re-run unfinished tests**.

## Automatic housekeeping and recovery

- **Scratch file quota.** Roihu's scratch has a file-count quota (500,000 files for the project). OpenFOAM writes thousands of files per parallel run. Once a run's logs and `postProcessing` are downloaded, the app deletes that run's folder on the cluster; a cancelled run's folder is deleted a minute after `scancel`. Only folders of the form `<folder>/runs/<job id>` are ever deleted. (On 18 Nov 2026 old folders filled the quota and every new run failed writing its files.)
- **Hull-motion blow-ups.** A light, wide, flat hull can make the body–fluid coupling diverge: the water it moves outweighs it. Such a wave run is retried automatically with stronger coupling (relaxation 0.2, 3 outer correctors), and if that also diverges, once more with relaxation 0.1, 5 correctors and a flow Courant limit of 0.5. The result records which level it needed.
- **Reusing identical runs.** Before submitting, a Full study fingerprints each generated case (all input files, job id masked). If a finished job has exactly the same files, typically the Quick run of the same test, its result is reused instead of queueing it again. Full then usually adds only the calm half-time-step runs.

## Time and allocation

- **Wall time:** all tests start together, so a Quick study takes about as long as its slowest test. A Full study takes about as long as one coarse run plus its slowest other check. Waiting for free nodes is extra; the app shows "Waiting for a compute node".
- **Billing units:** the cost is roughly *cores × hours* per job. Quick uses far less than Full. Check your project's remaining allocation in MyCSC.
- **Estimates:** the app learns the cluster's speed from finished runs, separately from your own computer's.

## If something fails

The app shows a plain-language reason. Common ones:

- **"The cluster refused the SSH login":** on Roihu, almost always a missing or expired daily certificate (step 3). Otherwise the key isn't added in MyCSC yet, the project doesn't have Roihu enabled, or the key has a passphrase that isn't loaded in `ssh-agent`.
- **"Stopped at its time limit":** raise *Max hours per run*, or choose a partition with a longer limit.
- **"Ran out of memory":** set *Memory per run*, e.g. 32.
- **"Solver not installed":** press **Install solver**.

Case files and logs are kept in the cluster folder under `runs/<job id>/`, and on your computer in `cfd-runs/`.

Check CSC's terms for your project, in particular that this use is allowed for a student project.
