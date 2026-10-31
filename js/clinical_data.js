/**
 * Clinical Knowledge Base & Essential Medicines Formulary
 * Aligned with WHO Essential Medicines List & National Primary Healthcare Guidelines
 */

const CLINICAL_DATA = {
  diseaseCategories: [
    { id: 'chronic', label: 'Chronic Disease', badge: 'CRN', examples: 'Hypertension, Type 2 Diabetes, Asthma, Osteoarthritis, Epilepsy, COPD' },
    { id: 'viral', label: 'Viral Infection', badge: 'VIR', examples: 'Viral Fever, Dengue, Influenza, Acute Viral Hepatitis, Measles, Gastroenteritis' },
    { id: 'emergency', label: 'Emergency / Acute', badge: 'EMG', examples: 'Snakebite, Acute Cardiac Chest Pain, Severe Dehydration, Anaphylaxis, Trauma' },
    { id: 'bacterial', label: 'Bacterial Infection', badge: 'BAC', examples: 'Pneumonia, Typhoid, Pulmonary Tuberculosis, Strep Pharyngitis, UTI, Cellulitis' },
    { id: 'vector', label: 'Vector-Borne / Parasitic', badge: 'VEC', examples: 'Malaria (Falciparum/Vivax), Kala-azar, Filariasis, Helminthiasis' },
    { id: 'maternal_pediatric', label: 'Maternal & Pediatric Care', badge: 'PED', examples: 'Antenatal Checkup, Severe Acute Malnutrition (SAM), Neonatal Care' }
  ],

  medicines: [
    // Analgesics & Antipyretics
    { name: 'Paracetamol 500mg Tab', category: 'Analgesic/Antipyretic', defaultDose: '1 tab TID after food for 3-5 days' },
    { name: 'Paracetamol 650mg Tab', category: 'Analgesic/Antipyretic', defaultDose: '1 tab SOS (max 3/day)' },
    { name: 'Paracetamol Syrup 120mg/5ml', category: 'Pediatric Antipyretic', defaultDose: '5ml TID as per weight' },
    { name: 'Ibuprofen 400mg Tab', category: 'NSAID / Anti-inflammatory', defaultDose: '1 tab BD after food' },
    { name: 'Diclofenac Sodium 50mg Tab', category: 'NSAID / Pain Relief', defaultDose: '1 tab BD after meals' },
    { name: 'Aspirin 75mg Gastro-resistant', category: 'Antiplatelet', defaultDose: '1 tab OD with evening food' },

    // Antibiotics & Antimicrobials
    { name: 'Amoxicillin 500mg Cap', category: 'Broad Spectrum Antibiotic', defaultDose: '1 cap TID for 5 days' },
    { name: 'Amoxicillin + Clavulanic Acid 625mg', category: 'Broad Spectrum Antibiotic', defaultDose: '1 tab BD for 5-7 days' },
    { name: 'Azithromycin 500mg Tab', category: 'Macrolide Antibiotic', defaultDose: '1 tab OD for 3-5 days' },
    { name: 'Ciprofloxacin 500mg Tab', category: 'Fluoroquinolone Antibiotic', defaultDose: '1 tab BD for 5 days' },
    { name: 'Doxycycline 100mg Cap', category: 'Tetracycline Antibiotic', defaultDose: '1 cap BD for 7 days' },
    { name: 'Metronidazole 400mg Tab', category: 'Antiprotozoal / Antibacterial', defaultDose: '1 tab TID for 5 days' },
    { name: 'Co-trimoxazole (Trimethoprim+Sulfamethoxazole)', category: 'Antibacterial', defaultDose: '1 double strength tab BD for 5 days' },

    // Gastrointestinal & Hydration
    { name: 'ORS (Oral Rehydration Salts WHO Formula)', category: 'Electrolyte Rehydration', defaultDose: '1 packet dissolved in 1L clean water, sip freely' },
    { name: 'Zinc Sulfate 20mg Dispersible Tab', category: 'Pediatric Diarrhea Adjunct', defaultDose: '1 tab OD dissolved in water for 14 days' },
    { name: 'Omeprazole 20mg Cap', category: 'Proton Pump Inhibitor (Antacid)', defaultDose: '1 cap OD 30 min before breakfast' },
    { name: 'Pantoprazole 40mg Tab', category: 'Proton Pump Inhibitor (Antacid)', defaultDose: '1 tab OD before meals' },
    { name: 'Domperidone 10mg Tab', category: 'Antiemetic / Prokinetic', defaultDose: '1 tab 15 mins before food' },
    { name: 'Ondansetron 4mg Tab', category: 'Antiemetic', defaultDose: '1 tab SOS for severe vomiting' },
    { name: 'Loperamide 2mg Cap', category: 'Antidiarrheal', defaultDose: 'Initial 2 caps, then 1 after each loose stool' },

    // Antiallergic & Respiratory
    { name: 'Cetirizine 10mg Tab', category: 'Antihistamine', defaultDose: '1 tab at night (OD)' },
    { name: 'Chlorpheniramine 4mg Tab', category: 'Antihistamine', defaultDose: '1 tab BD' },
    { name: 'Salbutamol Inhaler 100mcg', category: 'Bronchodilator (Asthma)', defaultDose: '2 puffs SOS via spacer' },
    { name: 'Dextromethorphan + Chlorpheniramine Syrup', category: 'Cough Suppressant', defaultDose: '10ml TID' },

    // Chronic Care (Cardiovascular & Diabetes)
    { name: 'Metformin 500mg Tab', category: 'Oral Antidiabetic', defaultDose: '1 tab BD with meals' },
    { name: 'Glimepiride 1mg Tab', category: 'Sulfonylurea Antidiabetic', defaultDose: '1 tab OD before breakfast' },
    { name: 'Amlodipine 5mg Tab', category: 'Antihypertensive (CCB)', defaultDose: '1 tab OD morning' },
    { name: 'Telmisartan 40mg Tab', category: 'Antihypertensive (ARB)', defaultDose: '1 tab OD morning' },
    { name: 'Atenolol 50mg Tab', category: 'Antihypertensive (Beta-blocker)', defaultDose: '1 tab OD' },
    { name: 'Atorvastatin 10mg Tab', category: 'Lipid-lowering Statin', defaultDose: '1 tab at bedtime' },

    // Antimalarial & Antiparasitic
    { name: 'Artemether + Lumefantrine (ACT)', category: 'Antimalarial', defaultDose: 'Full 3-day course (6 doses) with fatty food' },
    { name: 'Chloroquine 250mg Tab', category: 'Antimalarial', defaultDose: 'Per clinical weight protocol' },
    { name: 'Albendazole 400mg Tab', category: 'Anthelmintic (Deworming)', defaultDose: '1 tab chewable single dose' },
    { name: 'Ivermectin 12mg Tab', category: 'Antiparasitic / Scabies', defaultDose: '1 tab single dose empty stomach' },

    // Maternal & Emergency Essentials
    { name: 'Iron + Folic Acid (IFA) Tab', category: 'Maternal Micronutrient', defaultDose: '1 tab OD after food' },
    { name: 'Calcium + Vitamin D3 Tab', category: 'Micronutrient Supplement', defaultDose: '1 tab OD after lunch' },
    { name: 'Polyvalent Anti-Snake Venom (ASV) Inj', category: 'Emergency Antivenom', defaultDose: '10 vials in 500ml NS IV over 1 hr under close monitor' },
    { name: 'Normal Saline (0.9% NaCl) 500ml IV', category: 'IV Resuscitation Fluid', defaultDose: 'Titrate IV as per hydration status' }
  ]
};

if (typeof window !== 'undefined') {
  window.CLINICAL_DATA = CLINICAL_DATA;
}
