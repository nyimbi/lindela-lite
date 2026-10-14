
========================================================================================================
*****	As of 2025.01 there is a new version of CHIRPS, CHIRPS-v3				  ******
*****	https://chc.ucsb.edu/data/chirps3				  			  ******
*****				  								  ******
*****	CHIRPS v3 is now available! 				  				  ******
*****	Please visit https://www.chc.ucsb.edu/data/chirps3 				  	  ******
*****	to learn more about the updates and access the data. 				  	  ******
*****	Production of CHIRPS v2 will end after December 2026. 				  	  ******
*****	Users are encouraged to transition to CHIRPS v3 to ensure continuity of operations.  	  ******
*****				  								  ******
*****	   If you would like to recieve updates on CHIRPS send an email to			  ******
*****	        chirps@geog.ucsb.edu				  				  ******
*****				  								  ******
========================================================================================================

== README FOR ==

   Climate Hazards Group Infrared Precipitation with Stations (CHIRPS). 
   Quasi-global satellite and observation based precipitation estimates over land, 1981 to near-real time.

== PRODUCED BY ==

   Climate Hazards Group
   Department of Geography
   University of California at Santa Barbara

   In collaboration with:
   The USGS Famine Early Warning Systems Network (FEWS NET)

== SUMMARY ==

The Climate Hazards Group InfraRed Precipitation with Station (CHIRPS) data archive is a quasi-global (50S-50N), gridded 0.05 degree resolution, 1981 to near-real time precipitation time series. The terrestrial preciptation estimates, are available in daily to annual time intervals. In addition to the quasi-global extent, subsets of Western Hemisphere, Africa and the Central Americia/Caribbean regions are available. These are available in several formats (NetCDF, TIFF, BIL, PNG) and are located in separate subdirectories.

Two CHIRPS products are produced operationally: a rapid preliminary version, and a later final version. The preliminary CHIRPS product is available, for the entire domain, two days after the end of a pentad (2nd, 7th, 12th, 17th, 22nd and 27th). The preliminary CHIRPS uses only Global Telecommunications System (GTS) and Conagua (Mexico) data. The final CHIRPS product takes advantage of several other stations sources and is complete sometime in the third week of the following month. Final products for all times/domains/formats are calculated at that time.

== ONLINE INFO ==

   CHIRPS homepage
   http://data.chc.ucsb.edu/data/chirps
   
   CHIRPS FAQ 
   http://chg-wiki.geog.ucsb.edu/wiki/CHIRPS_FAQ

   CHIRPS paper
   http://pubs.usgs.gov/ds/832/


== VERSION HISTORY ==

   Version 3.0 released 2025.01.14
   Version 2.0 released 2015.02.12
   Version 1.8 released 2014.05.14
   Version 1.7 released 2013.05.01

== Changes in Version 2.0 ==

   Since v1.8 we have added new stations around the world. In particular, 400 in Peru, 1,200 across Africa from Sharon Nicholson, 11,000 in Brazil, over 1,000 in Mexico (Conagua), 76 from Southern Africa, 500 in Russia, 250 in Central Asia and 400 across Central America. In addition we have topped off data from several African countries. The Conagua stations are available in near-real time and will directly improve our preliminary CHIRPS product. 

   Daily data now available for the Globe

   NetCDF format added

   Replaced erroneous stations in Tanzania

   Expanded diagnostics, stations by Country plots, EWX rchecks, station comparison/*badness* plots, station density maps, pentad and monthly png's of excluded stations.



== ACCESS ==

   Online display and access,
     http://earlywarning.usgs.gov/fews/ewxindex.php


   Via anonymous ftp,
     ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/

   In a browser,
     ftp://ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/

   Using wget (Linux, Mac, cygwin)
   (example to get all global monthly CHIRPS tif's for 2013)
     wget ftp://ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/global_monthly/tifs/chirps-v2.0.2013*

   (In Progress)  Google Earth Engine   https://earthengine.google.org

   (In Progress)  Snippets: Ability to embed latest CHIRPS images into your webpage

== FOLDERS ==

   africa_6-hourly       Africa subset 6-hourly fields at 0.1 degree resolution. Special binary format.
   africa_daily          Africa subset daily fields at 0.05 and 0.25 degree resolution. BIL's and TIFF's.
   africa_dekad          Africa subset dekadal fields. BIL's, PNG's and TIFF's.
   africa_monthly        Africa subset monthly fields. BIL's, PNG's and TIFF's.
   africa_pentad         Africa subset monthly fields. BIL's, PNG's and TIFF's.
   camer-carib_dekad     Central America/Caribbean subset dekadal fields. BIL's and TIFF's.
   camer-carib_monthly   Central America/Caribbean subset monthly fields. BIL's and TIFF's.
   camer-carib_pentad    Central America/Caribbean subset pentadal fields. BIL's and TIFF's.
   diagnostics		 Various data/plots giving more detail about CHIRPS processing and results
   docs                  CHIRPS related documents.
   EAC_monthly		 East African Community monthly fields. BIL's and TIFF's.
   EAC_monthly_EWX	 East African Community monthly EWX fields. TIFF's.
   global_2-monthly      Quasi-global 2-monthly fields. TIFF's.
   global_2_EWX-monthly  Quasi-global 2-monthly EWX fields. TIFF's.
   global_3-monthly      Quasi-global 3-monthly fields. TIFF's.
   global_3_EWX-monthly  Quasi-global 3-monthly EWX fields. TIFF's.
   global_annual         Quasi-global annual fields. NetCDF's and TIFF's.
   global_daily          Quasi-global daily fields. NetCDF's and TIFF's.
   global_dekad          Quasi-global dekadal fields. BIL's, NetCDF's and TIFF's.
   global_dekad_EWX      Quasi-global dekadal fields. TIFF's.
   global_monthly        Quasi-global monthly fields. BIL's, NetCDF's and TIFF's.
   global_monthly_EWX    Quasi-global monthly fields. TIFF's.
   global_pentad         Quasi-global pentadal fields. BIL's, NetCDF's and TIFF's.
   prelim          	 Quasi-global Rapid CHIRPS with 2-day lag. GTS and Conagua (Mexico) stations only. 
   whem_daily            Western Hemisphere daily fields. TIFF's.

   EWX:  EWX files are data, anomaly and zscore used to populate the Early Warning eXplorer
	@EROS (operational):             http://earlywarning.usgs.gov/fews/ewxindex.php
	@CHG (development/experimental): http://chg-ewx.geog.ucsb.edu:8080/EWX/index.html

== DATA SET CITATION ==

   Funk, C.C., Peterson, P.J., Landsfeld, M.F., Pedreros, D.H., Verdin, J.P.,
   Rowland, J.D., Romero, B.E., Husak, G.J., Michaelsen, J.C., and Verdin, A.P.,
   2014, A quasi-global precipitation time series for drought monitoring: U.S.
   Geological Survey Data Series 832, 4 p.
   ftp://ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/docs/USGS-DS832.CHIRPS.pdf

== PUBLICATIONS ==

   ftp://ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/docs/USGS-DS832.CHIRPS.pdf


== GET ADDED TO OUR USERS LIST ==

   If you would like to recieve updates on CHIRPS 
   processing/validations/publications etc.  send an email to
        chirps@geog.ucsb.edu


== CONTACT ==

   Data:
   Pete Peterson
   pete@geog.ucsb.edu

   Science:
   Chris Funk
   chris@geog.ucsb.edu

   Web:   chc.ucsb.edu/data/chirps
          earlywarning.usgs.gov

   
== UPDATES/MESSAGES ==

April 2015:

CHIRPS data has recently been reprocessed for 1) CHIRPS final March 2015 files
(complete replacement) and 2) daily CHIRPS from 2000 to present. If you are
not interested in either of these two products, you can ignore the rest of
this message. 

In summary, two updates to CHIRPS 2.0 have been made.  First, CHIRPS final
data for March 2015 (all time steps/domains/formats) have been updated with
certain stations removed due to a new irregularity in the stations.  Second,
daily (not pentads, dekads or months) CHIRPS data from 2000-present have been
updated to correct areas falling in gaps in the IR coverage.  Outside of those
gap areas the daily CHIRPS are not affected.


1: CHIRPS final
After posting the final CHIRPS for March 2015, we found some locations where
the station data was obviously wrong. We have since developed an extra
screening step for catching this type of problem and reprocessed all the
CHIRPS final data for March 2015. If you downloaded March data earlier this
week (before Thursday, March 23rd), you should go back and download the data
again.  This new screening algorithm process will be included in our
processing going forward.

2: CHIRPS daily
Thanks to feedback from Marcel Kuettel, we realized a problem in daily CHIRPS
for the CPC-IR time period, 2000 to present. There was a problem creating the
daily percent cold cloud duration (%CCD) map used in the downscaling. Places
with missing IR data were set to zero instead of missing. Anywhere this
happened, the precipitation was set to zero. This was always a problem for
Eastern Australia/Indonesia/Japan, where a gap between two geostationary
satellites exists. There were a small number of times this problem occurred
outside of these particular areas. Browse .png images of daily %CCD before the
fix:

     	ftp://ftp.chc.ucsb/pub/org/chg/products/CHIRPS-2.0/diagnostics/CPC-IR_perctCCD_pngs/

under the subdirectories
	all_days_by_month
	singleProblemDays_outsideAustralia

If your region of interest falls within the negative (yellow) areas, you
should re-acquire the daily data for that entire month as problems with a
given day effect the partitioning of precipitation among the other days in
that month. 

/end April 2015 message
============================================================================================

   

