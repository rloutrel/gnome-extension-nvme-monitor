# SSD Monitoring Tool - TODO List

## 🔴 High Priority

- [ ] **Implémenter le suivi du TBW (Total Bytes Written)**
  - **Description** : Surveiller les écritures cumulées (en To) et comparer avec la valeur TBW du fabricant (ex. : 300 To pour le Samsung 980 500 Go).
  - **Action** : Déclencher une alerte si le TBW approche ou dépasse la limite garantie.
  - **Outils** : `smartctl`, `nvme smart-log` (Linux), SMART data.
  - **Fréquence** : Quotidienne.

- [ ] **Ajouter des alertes pour le seuil "Available Spare"**
  - **Description** : Alerter si *Available Spare* descend en dessous de **20%** (risque critique de panne).
  - **Outils** : Données SMART (CrystalDiskInfo, NVMe CLI).
  - **Fréquence** : Quotidienne.

- [ ] **Surveiller le "Percentage Used"**
  - **Description** : Alerter si *Percentage Used* dépasse **80%** (usure significative).
  - **Outils** : Données SMART.
  - **Fréquence** : Quotidienne.

- [ ] **Suivre les "Host Reads/Writes" en To**
  - **Description** : Enregistrer et afficher le total des **To lus/écrits** pour évaluer l'intensité d'utilisation.
  - **Action** : Convertir les comptes bruts de lectures/écritures en To si nécessaire.
  - **Outils** : SMART data, Samsung Magician.
  - **Fréquence** : Quotidienne.

---

## 🟡 Medium Priority

- [ ] **Surveiller l'indicateur "Media Wearout Indicator"**
  - **Description** : Cet attribut SMART (valeur initiale généralement à 100) diminue avec l'usure.
  - **Action** : Alerter si la valeur descend en dessous de **10**.
  - **Outils** : Données SMART.
  - **Fréquence** : Hebdomadaire.

- [ ] **Surveiller le "Uncorrectable Error Count"**
  - **Description** : Alerter si *Uncorrectable Error Count* > **0** (risque de corruption de données ou de défaillance des NAND).
  - **Outils** : Données SMART.
  - **Fréquence** : Hebdomadaire.

- [ ] **Surveiller la température (contrôleur et NAND)**
  - **Description** : Alerter si la température du contrôleur dépasse **85°C** ou celle des NAND dépasse **70°C** de manière prolongée.
  - **Outils** : SMART data, HWInfo.
  - **Fréquence** : Temps réel.

- [ ] **Enregistrer les événements de "Thermal Throttling"**
  - **Description** : Suivre et alerter si le SSD réduit ses performances en raison de températures élevées.
  - **Outils** : Données SMART, journaux système.
  - **Fréquence** : Temps réel.

---

## 🟢 Low Priority

- [ ] **Ajouter des tests de performance (Benchmarking)**
  - **Description** : Exécuter périodiquement des tests de vitesse de lecture/écriture pour détecter une dégradation.
  - **Action** : Alerter si les vitesses chutent significativement en dessous des valeurs attendues.
  - **Outils** : `fio`, `hdparm`, Samsung Magician.
  - **Fréquence** : Mensuelle.

- [ ] **Vérifier les mises à jour du firmware**
  - **Description** : Notifier si une nouvelle version du firmware est disponible (peut améliorer la gestion thermique ou corriger des bugs).
  - **Outils** : Outils du fabricant (Samsung Magician).
  - **Fréquence** : Mensuelle.

- [ ] **Rappels de sauvegarde des données**
  - **Description** : Si le TBW ou les indicateurs d'usure dépassent les seuils, rappeler à l'utilisateur de sauvegarder ses données critiques.
  - **Outils** : Notifications dans l'interface de l'outil.
  - **Fréquence** : Au dépassement des seuils.

---
