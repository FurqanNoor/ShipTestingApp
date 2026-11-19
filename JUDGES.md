# Judges' guide: set up the app on your own computer and CSC account

This guide is for the hackathon judges. Each judge runs the app on their own computer and sends the tests to CSC's Roihu supercomputer under their own CSC username. At the end, the judges combine everyone's results into one ranking.

Allow about 30–45 minutes the first time. Most of that is waiting for CSC to approve access.

## 1. CSC account and project (once)

1. **Get a CSC account.** Go to [my.csc.fi](https://my.csc.fi) and sign in, with your university login (Haka) if you have one. Accept the terms of use. Your CSC username is shown under *Profile*.
2. **Get access to a project with Roihu.** Choose one of these:
   - **A. Join Furqan's project (`project_2022733`).** Send Furqan your CSC username. In MyCSC he opens *Projects → project_2022733 → Members → Add members* and adds you. Accept the invitation in MyCSC. Everyone then shares that project's billing units.
   - **B. Use your own project.** In MyCSC, open or create a project (*Projects → New project*; academic staff can be the project manager). Under *Services*, add **Roihu** and wait for approval. The project needs billing units: one hull with all 9 tests uses about 1,000 core-hours.
3. **Check access.** In MyCSC, the project must list **Roihu** under *Services*, and you must be a member. New access can take up to an hour to reach Roihu.

## 2. Software (once)

Install these on Windows, macOS or Linux:

- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org) (current LTS or newer; the app is developed on Node 26)

Docker is **not** needed: the tests run on Roihu.

Then open a terminal (PowerShell on Windows) and run:

```
git clone https://github.com/FurqanNoor/ShipTestingApp.git
cd ShipTestingApp
npm install
```

## 3. SSH key (once) and certificate (every day)

1. **Create a key on your computer.** Press Enter at every question; leave the passphrase empty.
   ```
   ssh-keygen -t ed25519
   ```
2. **Add the public key in MyCSC.** Go to *Profile → SSH public keys → Add key*, and paste the contents of `C:\Users\<you>\.ssh\id_ed25519.pub` (on Mac/Linux, `~/.ssh/id_ed25519.pub`). Never share or copy the *private* key (the file without `.pub`).
3. **Sign the certificate (every day).** In MyCSC, under *Profile → SSH public keys*, click **⋮** next to your key, then **Sign and download SSH certificate**. Save the file **exactly** as `id_ed25519-cert.pub` in the same folder as your key, replacing yesterday's. It is valid for 24 hours. If your browser saves it under another name, rename it.
4. **Connect once** to accept Roihu's host key:
   ```
   ssh <your-csc-username>@roihu-cpu.csc.fi
   ```
   Answer `yes`, then type `exit`.
   - If it asks for a password or says *Permission denied (publickey)*: the certificate is missing or expired, or is saved under the wrong name (step 3).
   - Otherwise the key is not added yet (step 2), or your project access has not reached Roihu yet (section 1).

## 4. Start the app and connect it (first time)

1. **Start the app** in the `ShipTestingApp` folder:
   ```
   npm run cfd
   ```
   Then open **http://127.0.0.1:5173** in your browser. Keep the terminal window open while you use the app.
2. **Open the cluster settings.** Click **OpenFOAM** in the app, choose **Run on: Cluster (CSC Roihu)**, and open **Cluster settings**.
3. **Fill in two fields**, then press **Save**:
   - **CSC username**
   - **Project**, e.g. `project_2022733`

   Leave the rest as it is:
   - the folder fills itself in as `/scratch/<project>/<username>/hulltests`;
   - cores per test stays at **64**, the same for every judge, so the results are comparable.
4. **Press Test connection.** It checks SSH, Slurm, Apptainer and the folder.
5. **Press Install solver** once. It downloads OpenFOAM into your folder on Roihu, usually 5–20 minutes.

## 5. Test hulls

1. **Add the hulls:** click **Add STL**, or drop the files on the tank. Check that each hull sits right: deck up, bow at the orange arrow. Fix it with **Flip / Roll 90° / Turn 90°** and the unit setting if needed.
2. **Run the tests.** Select a hull, click **OpenFOAM** and press **Run tests**. The default is the full ranked set: **all 9 tests, Quick**. To run every hull you added, press **Queue for all hulls**.
3. **Wait for the results.** All of a hull's tests run at the same time on Roihu:

   | Test | Time |
   |---|---|
   | Wave tests | about 1 h |
   | Calm tows | about 2–3.5 h |
   | Waiting for a free node | anything from seconds to an hour |

   You can close the test window. **Keep the app running and the computer awake** (not asleep) until the tests finish: the app downloads each result as it finishes. If the app or computer restarts, start `npm run cfd` again; it re-attaches to the jobs on Roihu.
4. **Read the ranking.** Results appear in the **OpenFOAM ranking** on the main page:
   - Score = average of calm drag, maximum roll in waves and initial stability (GM), each 0–100 points.
   - While some hulls are still running, the ranking says *Provisional*.

Split the hulls between the judges. The same hull tested on two accounts just costs twice.

## 6. Combine the judges' results

1. **Export:** each judge presses **Export results** under the OpenFOAM ranking. This saves one file, `hull-results-<date>.json`, with every finished test and the tested hull shapes.
2. **Share:** send the files to one person, by Teams, email or USB stick.
3. **Import:** that person presses **Import results** and picks the files (several at once is fine). The ranking then includes everyone's hulls, and the imported hulls appear in the 3-D view.
   - Importing the same file twice changes nothing.
   - If two judges tested the same hull name, the newest result counts.

Everyone must use the **same app version**, so that all tests use the same setup. The setup is shown under the ranking ("setup calm …, waves …").
- **Update before the event:** run `git pull` then `npm install`.
- **Don't update mid-event:** a judge with a different setup is listed as *Different settings*, not mixed into the ranking.

## 7. Every day, and when something goes wrong

- **Each morning:** sign a new certificate (section 3, step 3).
  - The app shows how many hours it has left, and refuses to submit with an expired one.
  - Jobs already on Roihu keep running when it expires. Their results download once you save a new certificate.
- **"The cluster refused the SSH login":** the certificate is expired or wrongly named, the key is not in MyCSC yet, or your project access has not reached Roihu yet.
- **A test failed:** the test window explains why, in plain language.
  - *Timed out*, *Cancelled on the cluster* or *Solver became unstable*: press **Re-run unfinished tests**.
  - *Capsizes* or *Sinks*: a real result for that hull under the standard load.
- **Billing units:** check the project's remaining allocation in MyCSC. Quick costs about 1,000 core-hours per hull with all 9 tests.

More detail: [CLUSTER.md](CLUSTER.md) (cluster settings and housekeeping) and [OPENFOAM.md](OPENFOAM.md) (what the tests simulate, and their accuracy).
