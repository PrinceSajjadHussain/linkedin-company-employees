# LinkedIn Company Employees Scraper

Extract employees from any LinkedIn company page. Get names, positions, locations, skills, education, and even email addresses — **no LinkedIn account or cookies required**.

## ✨ Features

- 🔍 **Search & Filter** — Find employees by job title, location, seniority, industry, function, and more
- 👤 **Three Scraping Modes** — Short (basic info), Full (detailed profile), Full + Email
- 🏢 **Batch Processing** — Search across up to 10 companies at once, or up to 1,000 one-by-one
- 🔄 **Resume Support** — Automatically resumes from where it left off after interruptions
- ⚡ **No Login Required** — Uses LinkedIn's public Voyager API, no cookies or accounts needed
- 📧 **Email Discovery** — Pattern-based email generation with MX record validation

## 📥 Input

| Field | Type | Description |
|-------|------|-------------|
| `companies` | Array of strings | **Required.** LinkedIn company URLs or company names |
| `profileScraperMode` | String | `short` (default), `full`, or `full+email` |
| `maxItems` | Number | Maximum number of employee profiles to scrape (default: 100) |
| `searchQuery` | String | Free-text keyword search within the company |
| `jobTitles` | Array of strings | Filter by job titles (e.g., "Software Engineer") |
| `locations` | Array of strings | LinkedIn geo URN IDs for location filtering |
| `industryIds` | Array of strings | LinkedIn industry codes |
| `seniorityLevelIds` | Array of strings | Seniority level filter codes |
| `functionIds` | Array of strings | Job function filter codes |
| `yearsAtCurrentCompanyIds` | Array of strings | Years at current company filter |
| `yearsOfExperienceIds` | Array of strings | Total years of experience filter |
| `companyHeadcount` | Array of strings | Company size filter |
| `startPage` | Number | Page number to start scraping from (default: 1) |
| `companyBatchMode` | String | `all-at-once` (max 10) or `one-by-one` (max 1,000) |
| `proxyConfiguration` | Object | Apify proxy configuration |

### Example Input

```json
{
  "companies": [
    "https://www.linkedin.com/company/google/",
    "microsoft"
  ],
  "profileScraperMode": "full",
  "maxItems": 50,
  "searchQuery": "engineer",
  "jobTitles": ["Software Engineer", "Data Scientist"],
  "startPage": 1,
  "companyBatchMode": "all-at-once"
}
```

## 📤 Output

### Short Mode
```json
{
  "publicIdentifier": "johndoe",
  "linkedinUrl": "https://www.linkedin.com/in/johndoe",
  "firstName": "John",
  "lastName": "Doe",
  "headline": "Software Engineer at Google",
  "location": "San Francisco, California",
  "photo": "https://media.licdn.com/...",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Full Mode (includes everything from Short, plus)
```json
{
  "about": "Experienced software engineer...",
  "openToWork": false,
  "hiring": false,
  "premium": true,
  "influencer": false,
  "connectionsCount": 500,
  "followerCount": 1200,
  "currentPosition": [{ "companyName": "Google" }],
  "topSkills": "Python • JavaScript • Machine Learning",
  "experience": [
    {
      "position": "Software Engineer",
      "companyName": "Google",
      "companyLinkedinUrl": "https://www.linkedin.com/company/google/",
      "duration": "3 years 2 months",
      "startDate": { "month": "Jan", "year": "2021", "text": "Jan 2021" },
      "endDate": { "text": "Present" }
    }
  ],
  "education": [
    {
      "schoolName": "Stanford University",
      "degree": "Master of Science",
      "fieldOfStudy": "Computer Science"
    }
  ],
  "skills": [{ "name": "Python" }, { "name": "JavaScript" }],
  "certifications": [],
  "languages": [{ "name": "English", "proficiency": "Native" }]
}
```

### Full + Email Mode (includes everything from Full, plus)
```json
{
  "email": "john.doe@google.com",
  "emailSource": "pattern-match",
  "emailCandidates": [
    "john@google.com",
    "john.doe@google.com",
    "johndoe@google.com",
    "jdoe@google.com"
  ]
}
```

## 🔧 Profile Scraper Modes

| Mode | What You Get | Speed |
|------|-------------|-------|
| **Short** | Name, headline, location, photo | Fastest |
| **Full** | Everything above + experience, education, skills, about, certifications, etc. | Medium |
| **Full + Email** | Everything above + email discovery | Slowest |

## 🏢 Company Batch Modes

### All at Once (default)
- Searches across all companies in a single query
- Maximum **10 companies** per run
- Best for comparing employees across companies

### One by One
- Processes each company separately
- Maximum **1,000 companies** per run
- Best for large-scale data collection

## 🔍 Filtering

### Seniority Level Codes
| Code | Level |
|------|-------|
| 1 | Unpaid |
| 2 | Training |
| 3 | Entry |
| 4 | Senior |
| 5 | Manager |
| 6 | Director |
| 7 | VP |
| 8 | CXO |
| 9 | Partner |
| 10 | Owner |

### Years of Experience Codes
| Code | Range |
|------|-------|
| 1 | Less than 1 year |
| 2 | 1-2 years |
| 3 | 3-5 years |
| 4 | 6-10 years |
| 5 | More than 10 years |

### Years at Current Company Codes
| Code | Range |
|------|-------|
| 1 | Less than 1 year |
| 2 | 1-2 years |
| 3 | 3-5 years |
| 4 | 6-10 years |
| 5 | More than 10 years |

## ⚠️ Limitations

- LinkedIn may rate-limit requests — the actor includes built-in delays and retry logic
- LinkedIn's Voyager API is unofficial and may change without notice
- Free-text search (`searchQuery`) works best with single keywords
- Maximum **2,500 results** per unique search query (LinkedIn API limitation)
- Email discovery uses pattern matching and is not guaranteed to be accurate

## 🛠️ Technical Details

- Built with [Apify SDK](https://docs.apify.com/sdk/js/)
- TypeScript with ESM modules
- Uses LinkedIn's Voyager API with guest session (no authentication)
- Automatic state persistence for resume after failures
- Proxy support via Apify proxy configuration
- Rate limit handling with exponential backoff

## 🤝 Support

If you encounter issues or have feature requests, please open an issue on the [GitHub repository](https://github.com/PrinceSajjadHussain/linkedin-company-employees).

## 📄 License

This project is licensed under the ISC License.
