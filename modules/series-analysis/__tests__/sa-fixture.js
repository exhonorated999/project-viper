/*
 * Series Analysis test fixture: a 13-hit catalytic converter series,
 * 2026-10-01 → 2026-10-22, mostly Tue–Thu between 01:00 and 04:00,
 * drifting east week by week. Silver Nissan Altima at 5 incidents.
 */
'use strict';

const ROWS = [
    // reportNo,     date,         from,    to,      address,                     lat,      lng,       target,                     suspectVehicle,              suspects,                         method,                        locationType
    ['26-104411', '2026-10-01', '02:10', '',      '1420 Oak Hollow Dr',        39.7512, -105.0101, '2009 Toyota Prius',         'Silver Nissan Altima',      '2 M, dark hoodies',              'Battery saw, under 3 min',    'Driveway'],
    ['26-104502', '2026-10-03', '23:30', '05:45', '1388 Oak Hollow Dr',        39.7518, -105.0089, '2011 Honda Element',        '',                          '',                               'Battery saw',                 'Street parking'],
    ['26-104733', '2026-10-06', '01:40', '',      '2205 W 41st Ave',           39.7494, -105.0072, '2008 Toyota Prius',         'Silver Nissan Altima',      '2 M, dark hoodies; one w/ headlamp', 'Battery saw, under 3 min', 'Driveway'],
    ['26-104790', '2026-10-07', '01:00', '04:00', '2240 W 41st Ave',           39.7502, -105.0064, '2012 Toyota Tacoma',        'Dark SUV, no plate',        '',                               'Jack + battery saw',          'Apartment lot'],
    ['26-104851', '2026-10-08', '02:55', '',      '4110 Perry St',             39.7521, -105.0050, '2010 Honda Accord',         'Silver Nissan Altima',      '2 M',                            'Battery saw, under 3 min',    'Apartment lot'],
    ['26-104990', '2026-10-10', '',      '',      '4102 Perry St',             39.7515, -105.0043, '2007 Toyota Prius',         '',                          '',                               'Battery saw',                 'Street parking'],
    ['26-105102', '2026-10-13', '02:20', '',      '3980 Lowell Blvd',          39.7488, -105.0031, '2015 Toyota Prius',         'Silver Nissan Altima',      '2 M, dark hoodies',              'Battery saw, under 3 min',    'Driveway'],
    ['26-105166', '2026-10-14', '23:00', '06:00', '3955 Lowell Blvd',          39.7497, -105.0022, '2011 Honda Element',        'Dark SUV, no plate',        '',                               'Jack + battery saw',          'Street parking'],
    ['26-105210', '2026-10-15', '01:50', '',      '3920 Meade St',             39.7509, -105.0011, '2009 Toyota Prius',         '',                          '1 M, headlamp',                  'Battery saw, under 3 min',    'Driveway'],
    ['26-105377', '2026-10-17', '02:30', '03:30', '3901 Meade St',             39.7520, -105.0004, '2013 Ford F-150',           '',                          '',                               'Battery saw',                 'Apartment lot'],
    ['26-105501', '2026-10-20', '03:05', '',      '3840 Newton St',            39.7493, -104.9992, '2010 Toyota Prius',         'Silver Nissan Altima',      '2 M, dark hoodies',              'Battery saw, under 3 min',    'Driveway'],
    ['26-105560', '2026-10-21', '01:15', '03:45', '3822 Newton St',            39.7505, -104.9984, '2012 Honda Element',        '',                          '',                               'Battery saw',                 'Street parking'],
    ['26-105633', '2026-10-22', '02:40', '',      '',                          null,     null,     '2014 Toyota Prius',         '',                          '2 M',                            'Battery saw, under 3 min',    'Driveway']
];

function incidents13() {
    return ROWS.map((r, i) => ({
        id: 'inc_' + (i + 1),
        reportNo: r[0], date: r[1], timeFrom: r[2], timeTo: r[3], address: r[4], lat: r[5], lng: r[6],
        offense: 'Theft - catalytic converter', notes: '',
        attrs: { target: r[7], suspectVehicle: r[8], suspects: r[9], method: r[10], locationType: r[11], footage: i % 4 === 0 ? 'Neighbor doorbell' : '' },
        source: { type: 'manual' }, createdAt: '2026-10-23T10:00:00Z', updatedAt: '2026-10-23T10:00:00Z'
    }));
}

module.exports = { incidents13 };
